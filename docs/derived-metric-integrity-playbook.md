# Derived metric integrity playbook

> **The rule, in one sentence:** if a column's name encodes a time window, the SQL that populates it MUST enforce that the chosen baseline observation falls inside a tolerance band around the nominal age — not merely "no newer than the nominal age." A column named `change_pct_24h` that compares to a baseline three weeks old is not a math bug; it's a contract violation, and the contract is the column name.

This is not an external-API issue (no API failed) and not an ingestion issue (ingestion was fine). It is a *derivation* issue: honest source data, dishonest derived output.

**Audience:** anyone writing or reviewing SQL functions that populate `card_metrics`, `variant_metrics`, `public_card_metrics`, or any other materialized derived-metric table.

**Last updated:** 2026-06-11 — added the JP two-writer clobber incident and Rule 3 (one writer per row; the partition predicate is part of the contract).

---

## Incident — 2026-05-01: Top Movers `+139% in 24h` on a sparse vintage card

**Symptom:** Rhyhorn (Skyridge) showed `+139% in 24h` on the homepage Top Movers rail; its 7-day chart wouldn't render and the 30-day chart looked flat. Rayquaza & Deoxys (HGSS) was being featured on the homepage two days running with similarly suspect numbers.

**Root cause:** `public.refresh_price_changes()` (defined in `supabase/migrations/20260303115000_refresh_price_changes_no_lock_timeout.sql`) computed `change_pct_24h` and `change_pct_7d` with a baseline selected as:

```sql
WHERE rp.ts <= cutoff_24h
ORDER BY rp.ts DESC LIMIT 1
```

i.e. **"the most recent observation at-or-before now-24h"** — with no requirement that the chosen baseline be *near* 24h ago. For sparse cards (then often 1–3 historical JustTCG observations in 30 days; today the same risk applies to sparse Scrydex observations), the chosen baseline was often weeks old. The function then computed `((today − 3-weeks-ago) / 3-weeks-ago) × 100` and wrote the result into a column **named** `change_pct_24h`.

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

## Incident — 2026-06-11: JP change badges blank/flapping — two uncoordinated writers on `change_pct_24h/7d`

**Symptom (reported 2026-06-10):** JP-language cards showed a market price but a blank, flapping, or wrong-basis 24h/7d change badge; EN cards showed both. The badge looked right for a stretch, then degraded — on a cycle.

**Root cause:** `card_metrics.change_pct_24h/7d` on canonical RAW rows had TWO uncoordinated writers:

1. `compute_jp_card_price_changes()` ([`20260520140000_compute_jp_card_price_changes.sql`](../supabase/migrations/20260520140000_compute_jp_card_price_changes.sql)) — the intended owner for JP-language slugs. JP-native deltas from `jp_card_price_history` (Yahoo JP + Snkrdunk, JPY basis). Runs every 12h via `refresh-card-metrics`.
2. `refresh_price_changes_core()` — the EN populator. PR #147 (migration `20260531120000`) switched its `changes` CTE to a LEFT-JOINed `canonical_scope` over ALL canonical RAW rows with **no language filter**, so for JP rows it wrote computed NULLs (no fresh Scrydex points) or Scrydex-basis values — the US-reflection series, ~100× off the displayed JP-native price.

The targeted wrapper path (`refresh_price_changes_for_cards` via batch-refresh-pipeline-rollups, twice-hourly, fed by Scrydex ingests — 11k of 13k JP slugs have incidental Scrydex rows) out-called the JP populator ~500:1. The 12h JP tick repaired; the twice-hourly EN path re-clobbered. Hence the flapping.

**Measured blast radius (2026-06-11):** 592 of 3,092 JP slugs with 7d support held NULL mid-cycle; 1,685 of 3,027 JP 24h values were Scrydex-basis residue; 2,887 of 3,025 JP-native values were exactly 0 — that last group is the *expected* degenerate, not residue (see below).

**Fix (PR #230, commit `24f90e5`, migration [`20260612014500_refresh_price_changes_core_excludes_jp.sql`](../supabase/migrations/20260612014500_refresh_price_changes_core_excludes_jp.sql), verified in prod 2026-06-12):** `canonical_scope` now excludes slugs with `canonical_cards.language = 'JP'` — the EXACT predicate `compute_jp_card_price_changes()` scopes by, so the two writers partition with no gap and no overlap (slugs missing from `canonical_cards`, or with NULL language, stay EN-managed). A one-shot `compute_jp_card_price_changes()` repair ran at apply time. Post-verification: Scrydex residue = 0; 2,648 / 3,446 priced JP cards carry a JP-native change.

**Diagnostic signature of two-writer churn** — this is how you spot the class, on any derived column:

1. A value that is correct right after one cron tick and degrades on a *different* cadence (here: 12h repair vs. twice-hourly clobber).
2. `pg_stat_statements` call-count asymmetry between the suspected writers (~500:1 here).
3. Values whose **basis** doesn't match the displayed price — e.g. a change computed on a $1.02 series under a ¥-native $102 display price.

**Degenerate ≠ residue:** a single point in the baseline window → exactly 0% change is EXPECTED behavior at sparse scrape cadence, not a bug. Distinguish it from cross-writer residue by checking `jp_card_price_history` support within 14d:

```sql
-- Cross-writer residue: JP rows holding a change with no JP history to back it. Expect 0.
-- The NOT EXISTS must mirror compute_jp_card_price_changes' EXACT history scope
-- (canonical-level RAW with positive price_jpy — 20260520140000 lines 181-185 /
-- stale-wipe 301-306); looser predicates count per-printing or jpy-less rows as
-- "support" and under-report residue.
SELECT COUNT(*) FROM card_metrics cm
JOIN canonical_cards cc ON cc.slug = cm.canonical_slug AND cc.language = 'JP'
WHERE cm.printing_id IS NULL AND cm.grade = 'RAW'
  AND (cm.change_pct_24h IS NOT NULL OR cm.change_pct_7d IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM jp_card_price_history h
    WHERE h.canonical_slug = cm.canonical_slug AND h.grade = 'RAW'
      AND h.printing_id IS NULL
      AND h.price_jpy IS NOT NULL AND h.price_jpy > 0
      AND h.recorded_at >= now() - interval '14 days');
```

**Vocabulary-drift risk (open follow-up):** the partition rests on the literal `language = 'JP'` on an **unconstrained text column** (prod vocabulary is strictly EN/JP today: 23,513 / 20,709). A matcher writing `'JA'` or lowercase `'jp'` would silently route those cards to the EN writer — same bug, new spelling. Hardening (a shared `is_jp_canonical()` helper or a CHECK constraint) is flagged but NOT yet shipped.

**Companion changes (landed 2026-06-12):** PR #231 retired the iOS client-side badge-suppression guards (they existed only because the basis was wrong); PR #233 added `jp_refresh_tier` + `scan_*_refresh_candidates` RPCs so hot JP cards (rank-capped at 500 + viewed force-include; 577 at rollout) scrape daily and true 24h pairs can exist (at the old flat weekly cadence only ~107 of 5,349 slugs ever had one). Yahoo's hot throttle requires *demonstrated* Snkrdunk ownership — a canonical RAW row observed within 96h — so code-null/suppressed/starved Snkrdunk rows hand the daily cadence back to Yahoo automatically. The queued JP display-basis change landed next (`20260613150000`): `jp_display_change_pct_24h/7d` are computed from the SAME blended daily series as the displayed `jp_display_price` median (the EN #147 pattern), so the badge basis matches the displayed price series exactly.

**Tiered display floor (`20260614150000`):** the JP display series is now two-tier. The trusted pass (`sample_count >= 3`) is unchanged and is the ONLY source of `jp_display_change_pct_*`; a thin pass (`sample_count >= 1`, only for metrics the trusted pass leaves displayless) fills `jp_display_price`/`jp_latest_price` so 1–2-sample-only JP cards display a price instead of nothing. `card_metrics.jp_display_sample_count` records the max in-window sample count behind every displayed value; `public_card_metrics` keys the EN single-source trust grammar on it (`< 3` → confidence 30, `market_low_confidence = true`, `market_price_display_state = 'JP_LOW_SAMPLE'`, public `change_pct_24h/7d` hard-NULLed ahead of the base-change fallback — a thin price never wears a change badge, not even a stale base one). Integrity check: any JP-RAW `public_card_metrics` row with `jp_display_sample_count < 3` and a non-null `change_pct_24h/7d` is a regression. The weekly `check-jp-source-divergence` cron doubles as the display-liveness alarm (`displayStale` when `max(jp_display_price_as_of)` ages past 48h) because the metric-row GC exemption ties JP row survival to the hourly display cron.

**EN-RAW cheap diverged floor (`20260620120000`):** an EN-RAW card classified `PRICECHARTING_DIVERGED` (Scrydex vs PriceCharting differ by both `> 35%` AND `> $1` — the `canonical_trusted_raw_prices` agreement gate) is normally hard-nulled (`POPALPHA_MARKET_QUARANTINED`, iOS shows the "sources disagree too much" note). For genuinely cheap commons that suppresses a price that doesn't matter: e.g. Scrydex `$0.01` vs PriceCharting `$1.44`. When **both** sources agree it's low-dollar — `greatest(scrydex, pricecharting) <= $2` — and it's not a `raw_market_price_outlier`, `public_card_metrics` now surfaces `least(scrydex, pricecharting)` (the conservative floor) at confidence **25**, `market_low_confidence = true`, NO change badge, `market_blend_policy = 'POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR'`, `market_price_display_state = 'PRICECHARTING_CHEAP_DIVERGED'`, provenance `confidenceStatus = LOW` / `publicInputStatus = SUPPORTED` / no `quarantineReason` (but `internalGuardrailStatus = DIVERGED` is retained — the divergence is real, we just judge it immaterial at this price). Gating on the HIGHER source is the safety rail: a `$0.01`-vs-`$50` conflict (greatest `> $2`) stays suppressed so we never understate a possibly-valuable card. The `<= $1` band needs no branch — the existing `|delta| <= $1` absolute escape in `canonical_trusted_raw_prices` already MATCHes those. Pure view redefinition; no iOS/web change (the diverged note auto-hides once the hero is non-`—`; web renders `<= $2` as the "low-dollar card" kind). Integrity check: an EN-RAW row with `market_blend_policy = 'POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR'` must have a non-null `market_price <= $2`, confidence 25, and null `change_pct_24h/7d`.

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

## The three rules (internalize these)

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

### Rule 3 — One writer per row; the partition predicate is part of the contract

`card_metrics.change_pct_24h/7d` on canonical RAW rows is partitioned by `canonical_cards.language`: `'JP'` rows are written ONLY by `compute_jp_card_price_changes()`; everything else ONLY by `refresh_price_changes_core()`. Any new writer, or any scope change to either function, must preserve this partition — grep BOTH function bodies (latest migration, per the latest-body rule in MEMORY) before touching either. A scope widened "for completeness" (the no-language-filter LEFT JOIN in PR #147) is exactly how a second writer sneaks in: each writer is individually correct, and the row is wrong most of the time.

---

## Code-review checklist for new derived-metric SQL

When reviewing any migration that adds or modifies a function populating a derived-metric column:

1. **Does the column name imply a time window?** (`_24h`, `_7d`, `_30d`, `_90d`, `_ytd`, etc.)
   - If yes: is there a tolerance band on the baseline timestamp? Or is it just `WHERE ts <= cutoff ORDER BY ts DESC LIMIT 1`? The second form is the bug.
2. **Is there an outlier cap?** A %-change column with no upper bound on output magnitude is a foot-gun. `|x| > 200` should NULL out — pricing data legitimately above 200% over a *day* is implausible enough that NULL is safer than the number.
3. **Is there a NULL-out branch for insufficient data?** What happens when only one observation exists in the relevant window? Two? Confirm the function returns NULL, not zero, not the latest price, not a stale fallback.
4. **Is the function idempotent on bad rows?** If row R was populated with a bad value yesterday and today the function runs again with the new tolerance band, will it overwrite R with NULL? It should. Watch out for `INSERT ... ON CONFLICT DO NOTHING` patterns that leave stale rows alive.
5. **Do downstream consumers handle NULL?** Grep for the column name across `app/api/`, `lib/data/`, `lib/ai/`, `ios/PopAlphaApp/`. Any caller treating NULL as 0 reintroduces the bug at the consumer layer.
6. **Does another function already write this column?** `git grep -l 'change_pct_24h' supabase/migrations/` (or the column in question) and find every `UPDATE`/`INSERT` writer. If there are two, their scopes must partition *exactly* — same predicate, one side negated. "Mostly disjoint" means the row flaps on whichever writer runs more often.

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

- Fix migrations (2026-05-01 incident): `supabase/migrations/20260501010000_refresh_price_changes_time_anchored_baseline.sql`, `supabase/migrations/20260501010100_compute_daily_top_movers_outlier_cap.sql`
- Fix migration (2026-06-11 incident): `supabase/migrations/20260612014500_refresh_price_changes_core_excludes_jp.sql` (PR #230); the two partitioned writers: `supabase/migrations/20260520140000_compute_jp_card_price_changes.sql` (JP) and `refresh_price_changes_core()` latest body (find via the latest-body grep — it gets redefined often)
- Clobber transport path (the cadence side of the 2026-06-11 incident): `docs/ingestion-pipeline-playbook.md` rollup-drain sections (`refresh_price_changes_for_cards` via `pending_rollups`)
- Predecessor RPC (the buggy one): `supabase/migrations/20260303115000_refresh_price_changes_no_lock_timeout.sql`
- Related but distinct concern: `docs/external-api-failure-modes.md` (silent fallbacks; that's "the API died and we returned ok:true" — this doc is "the data was honest and the derivation lied").
- Consumer-layer floors that did NOT save us: `lib/data/homepage.ts` (`MIN_MOVER_CHANGE_PCT`, `MIN_MOVER_SNAPSHOT_COUNT_30D`).
