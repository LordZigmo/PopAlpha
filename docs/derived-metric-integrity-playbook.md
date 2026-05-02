# Derived metric integrity playbook

> **The rule, in one sentence:** if a column's name encodes a time window, the SQL that populates it MUST enforce that the chosen baseline observation falls inside a tolerance band around the nominal age — not merely "no newer than the nominal age." A column named `change_pct_24h` that compares to a baseline three weeks old is not a math bug; it's a contract violation, and the contract is the column name.

This is not an external-API issue (no API failed) and not an ingestion issue (ingestion was fine). It is a *derivation* issue: honest source data, dishonest derived output.

**Audience:** anyone writing or reviewing SQL functions that populate `card_metrics`, `variant_metrics`, `public_card_metrics`, or any other materialized derived-metric table.

**Last updated:** 2026-05-01 — initial entry after the Top Movers `+139% 24h` incident on a sparse vintage card.

---

## Incident — 2026-05-01: Top Movers `+139% in 24h` on a sparse vintage card

**Symptom:** Rhyhorn (Skyridge) showed `+139% in 24h` on the homepage Top Movers rail; its 7-day chart wouldn't render and the 30-day chart looked flat. Rayquaza & Deoxys (HGSS) was being featured on the homepage two days running with similarly suspect numbers.

**Root cause:** `public.refresh_price_changes()` (defined in `supabase/migrations/20260303115000_refresh_price_changes_no_lock_timeout.sql`) computed `change_pct_24h` and `change_pct_7d` with a baseline selected as:

```sql
WHERE rp.ts <= cutoff_24h
ORDER BY rp.ts DESC LIMIT 1
```

i.e. **"the most recent observation at-or-before now-24h"** — with no requirement that the chosen baseline be *near* 24h ago. For sparse cards (1–3 JustTCG observations in 30 days), the chosen baseline was often weeks old. The function then computed `((today − 3-weeks-ago) / 3-weeks-ago) × 100` and wrote the result into a column **named** `change_pct_24h`.

The math was correct. The label was a lie.

**Blast radius:** every consumer trusted the column name. The bad number propagated unchecked to:
- `app/c/[slug]/page.tsx` change badge
- `lib/data/homepage.ts:545–572` Top Movers / Biggest Drops live query (sorts on the column)
- `compute_daily_top_movers` cron RPC (cached inflated values for 24h in `daily_top_movers`)
- `lib/ai/homepage-brief.ts` `topByChange()` → LLM prompt → AI brief story narrative
- Search results, set pages, card-tile mini change badges, personalized homepage rail
- iOS Signal Board (consumes `/api/homepage`)

JS-layer floors didn't help. `MIN_MOVER_CHANGE_PCT = 2.5` and `MIN_MOVER_SNAPSHOT_COUNT_30D = 27` in `lib/data/homepage.ts` are *floors*, not *ceilings*, and `snapshot_count_30d` reflects how often the **provider polled** (Scrydex polls daily) — not how often the **price actually changed** — so a sparse vintage card easily clears 27.

**Fix:** `supabase/migrations/20260501010000_refresh_price_changes_time_anchored_baseline.sql` rewrites the RPC so the baseline observation must fall inside a tolerance window around the nominal age:
- 24h delta: baseline must be in `[now − 30h, now − 18h]` (±6h around "24h ago")
- 7d delta: baseline must be in `[now − 8d, now − 6d]` (±1d around "7d ago")
- Outlier cap: `|change_pct| > 200` is suppressed to NULL

When the rule fails, the column is `NULL`. Every downstream consumer already filters `IS NOT NULL` and orders `nullsFirst: false`, so NULL at the source flows through cleanly — no JS-layer guards needed. A second migration (`supabase/migrations/20260501010100_compute_daily_top_movers_outlier_cap.sql`) adds a tighter 75% cap on the daily homepage rails as belt-and-suspenders.

---

## Diagnostic shortcut

When a user reports an implausible %-change on a card (`/c/[slug]`, homepage rails, search, AI brief), run this against the variant's `provider_card_id`:

```sql
SELECT phs.ts, phs.median_price
FROM price_history_points phs
WHERE phs.provider_card_id = '<id>'
  AND phs.ts >= NOW() - INTERVAL '14 days'
ORDER BY phs.ts DESC
LIMIT 10;
```

If the latest two points are **> 30h apart**, the time-anchored-baseline rule SHOULD have nulled `change_pct_24h`. If `card_metrics.change_pct_24h` is non-NULL anyway, either:
1. The metric pre-dates the 2026-05-01 fix and `refresh_price_changes` hasn't run since, or
2. A *new* derived-metric function was added that re-introduced the same bug shape.

Cross-check `pg_stat_statements` for `refresh_price_changes` recent-call timestamps. If it's been called and the bad row persists, it's case (2) — a regression in a sibling RPC.

---

## The two rules (internalize these)

### Rule 1 — A window-named column must enforce its window

If the column name is `change_pct_24h`, `volume_7d`, `realized_gain_30d`, `median_7d`, `provider_trend_slope_7d`, `*_90d`, `*_24h`, *anything* with a time suffix, the SQL populating it MUST verify that the data points used to compute it are positioned correctly **in time**, not just **filtered to "before now"**. A baseline 3 weeks old satisfies "before 24h ago" — and produces nonsense.

The defensive idiom is a tolerance band:

```sql
WHERE rp.ts BETWEEN (now() - nominal_age - tolerance)
                AND (now() - nominal_age + tolerance)
ORDER BY abs(extract(epoch from (rp.ts - (now() - nominal_age))))
LIMIT 1
```

If no observation falls in the band, emit NULL.

### Rule 2 — NULL is the correct answer when data doesn't support a derived metric

Don't invent a number. The whole stack is already wired to skip NULLs (`IS NOT NULL` filters, `nullsFirst: false` orderings, conditional rendering on the iOS side). Adding JS-layer guards because the SQL source lies is whack-a-mole — fix the contract at the source.

---

## Code-review checklist for new derived-metric SQL

When reviewing any migration that adds or modifies a function populating a derived-metric column:

1. **Does the column name imply a time window?** (`_24h`, `_7d`, `_30d`, `_90d`, `_ytd`, etc.)
   - If yes: is there a tolerance band on the baseline timestamp? Or is it just `WHERE ts <= cutoff ORDER BY ts DESC LIMIT 1`? The second form is the bug.
2. **Is there an outlier cap?** A %-change column with no upper bound on output magnitude is a foot-gun. `|x| > 200` should NULL out — pricing data legitimately above 200% over a *day* is implausible enough that NULL is safer than the number.
3. **Is there a NULL-out branch for insufficient data?** What happens when only one observation exists in the relevant window? Two? Confirm the function returns NULL, not zero, not the latest price, not a stale fallback.
4. **Is the function idempotent on bad rows?** If row R was populated with a bad value yesterday and today the function runs again with the new tolerance band, will it overwrite R with NULL? It should. Watch out for `INSERT ... ON CONFLICT DO NOTHING` patterns that leave stale rows alive.
5. **Do downstream consumers handle NULL?** Grep for the column name across `app/api/`, `lib/data/`, `lib/ai/`, `ios/PopAlphaApp/`. Any caller treating NULL as 0 reintroduces the bug at the consumer layer.

---

## Currently-vulnerable call sites (audit list)

These columns have window-suffixed names. The 2026-05-01 fix only touched `change_pct_24h` and `change_pct_7d`. The rest still need to be audited against Rule 1:

- **`card_metrics.market_price_as_of`** — does this accurately reflect "as of when," or is it just `MAX(ts)` regardless of staleness? If a variant hasn't been observed in 21 days, `market_price_as_of` returning 21 days ago is honest; returning *now* is the same shape of bug as this incident.
- **`card_metrics.snapshot_count_30d`** — counts observations, not price changes. Used as a freshness floor in `lib/data/homepage.ts`. Re-confirm semantics are documented in any place this is used as a quality gate.
- **`card_metrics.active_listings_7d`** — verify the 7d window is actually 7d and not "everything we have."
- **`variant_metrics.provider_price_changes_count_30d`** — verify "30d" is enforced as a window, not as a `LIMIT 30` or similar.
- **`variant_metrics.provider_trend_slope_7d`** — slopes computed over irregularly-spaced observations are subtle; confirm the regression uses real timestamps and that the 7d window is bounded on both ends.
- **Anything else surfaced by:** `git grep -E '_(24h|7d|30d|90d|ytd|lifetime)' supabase/migrations/ | grep -i 'create.*function\|materialized view'`

If the audit turns up a column populated with a "≤ cutoff, take the latest" pattern, file an issue or fix it inline using the tolerance-band idiom above.

---

## Cross-references

- Fix migrations: `supabase/migrations/20260501010000_refresh_price_changes_time_anchored_baseline.sql`, `supabase/migrations/20260501010100_compute_daily_top_movers_outlier_cap.sql`
- Predecessor RPC (the buggy one): `supabase/migrations/20260303115000_refresh_price_changes_no_lock_timeout.sql`
- Related but distinct concern: `docs/external-api-failure-modes.md` (silent fallbacks; that's "the API died and we returned ok:true" — this doc is "the data was honest and the derivation lied").
- Consumer-layer floors that did NOT save us: `lib/data/homepage.ts` (`MIN_MOVER_CHANGE_PCT`, `MIN_MOVER_SNAPSHOT_COUNT_30D`).
