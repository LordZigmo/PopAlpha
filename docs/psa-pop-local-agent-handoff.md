# Handoff: PSA Pop Verification & Activation (local agent)

**Audience:** an agent running on the owner's Mac with the repo cloned,
`.env.local` populated, and real network access. You are the hands for a
system that was built in a remote sandbox that cannot reach PSA,
Supabase, or production. Read `docs/ROADMAP.md` (Population Tables
section) and `docs/psa-specid-mapping-handoff.md` (including both 2026-06-11
addenda) before starting — this doc tells you WHAT to do, those tell you
WHY it's shaped this way.

## The one-paragraph mission

Phases 2 and 2b of Population Tables are code-complete on branch
`claude/happy-archimedes-slu1ux`: SpecID → catalog matching
(`psa_spec_card_map`, cron `match-psa-specs`) and whole-catalog SpecID
discovery via PSA pop-report set pages (`psa_pop_set_pages`, cron
`discover-psa-specs` — built but deliberately unscheduled). Your job:
verify the scrape mechanics against live PSA, get the migrations applied
the house way, run the matcher and curate its queue, prove discovery on
real sets, decide whether the discovery cron can be scheduled, and leave
verified artifacts behind.

## What you have that the builder didn't

- Residential egress to `www.psacard.com` (Cloudflare blocked the
  sandbox) and `api.psacard.com`.
- Supabase prod access via `.env.local`
  (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; possibly a
  direct `psql` URL).
- `CRON_SECRET` for hitting prod/preview cron routes.
- The PSA API bearer token (`PSA_API_TOKEN` or similar — check
  `.env.local` / `lib/psa/client.ts` for the exact name).

## Hard rules (non-negotiable)

1. **Never push to main.** Small fixes go on the existing feature branch
   (or a fresh `claude/`-prefixed branch + PR if it's already merged).
2. **Schema migrations are applied ONLY by merging to main** —
   `.github/workflows/supabase-migrations.yml` runs
   `supabase db push --include-all`. Do NOT paste migration SQL into the
   Dashboard SQL Editor; that exact shortcut caused the 2026-05-01 drift
   incident (`docs/migration-drift-postmortem-2026-05-01.md`). Plain
   DATA SQL (inserts/updates on `psa_set_map`, `verified` flags,
   inspection queries) is fine to run directly.
3. **`psa_spec_card_map.verified = true` rows are owner-confirmed ground
   truth.** Set the flag only after a human-equivalent spot-check (see
   step 6); the pipeline never overwrites verified rows, and neither do
   you.
4. **Wrong matches are worse than no matches.** If a match looks dubious,
   leave it queued and record why. Never hand-edit `canonical_slug` to
   force a match without the spot-check.
5. **Scrape politely.** The client already paces (1.5s between pages,
   page caps). Run small batches (≤5 pages per run), stop and report on
   repeated 403s — do not start a stealth/evasion arms race.
6. **The official PSA API budget (~100 calls/day, shared with live slab
   scans) belongs to `snapshot-psa-pop` + scans.** Discovery costs zero
   API calls by design; keep it that way. No cert-number enumeration.

## System map

| Piece | Where |
| --- | --- |
| Pure matching logic | `lib/psa/spec-match.ts` (tests: `npm run test:psa-spec-match`) |
| Matcher runner | `lib/backfill/psa-spec-match.ts` (env: `PSA_SPEC_MIN_AUTO_MATCH_CONFIDENCE`=0.9, `PSA_SPEC_UNMATCHED_RETRY_HOURS`=24) |
| Match cron + audit report | `GET /api/cron/match-psa-specs` — `?specId= ?force=1 ?dryRun=1 ?mode=report`; scheduled 08:20 UTC |
| Scrape client | `lib/psa/pop-scrape.ts` (tests: `npm run test:psa-pop-scrape`; env: `PSA_POP_SCRAPE_USER_AGENT`) |
| Discovery runner | `lib/backfill/psa-spec-discovery.ts` |
| Discovery cron (UNSCHEDULED) | `GET /api/cron/discover-psa-specs` — `?headingId= ?limit= ?dryRun=1 ?noSnapshot=1 ?noMatch=1` |
| Discovery CLI (your main tool) | `node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs scripts/discover-psa-specs.mjs --headingId=N [--pages=N] [--dry-run]` |
| Tables | `psa_spec_targets` (+`fields`,`pop_heading_id`,`priority`,`canonical_slug`), `psa_spec_card_map`, `psa_set_map`, `psa_pop_set_pages`, `psa_spec_pop_snapshots` (+`source`) |
| Migrations in flight | `20260611233000_psa_spec_card_mapping.sql`, `20260612000000_psa_spec_discovery.sql` (and Phase 1's `20260611213000_psa_spec_pop_snapshots.sql` if prod doesn't have it yet) |
| Cron auth | `Authorization: Bearer $CRON_SECRET` |

All cron runs log to `ingest_runs` (job `psa_spec_match` /
`psa_spec_discovery`, source `psa`).

## Task list (in order)

### 0. Setup sanity (5 min)

```bash
git fetch origin && git checkout claude/happy-archimedes-slu1ux && git pull
npm install
npm run test:psa-spec-match && npm run test:psa-pop-scrape
npx tsc --noEmit
```

### 1. Recon GetSetItems (pre-merge; no DB needed)

In a browser: psacard.com → Pop Report → TCG Cards → open a Pokémon
set page (use "Pokemon Japanese SV4a Shiny Treasure ex" — we hold a
known spec, 10041062 Mew ex #347, to cross-check). From the page URL,
the trailing number is the **headingId**. In DevTools → Network, find
the `GetSetItems` XHR and note the **categoryID** for TCG. Then verify
plain curl works (this is what our client sends):

```bash
curl -s 'https://www.psacard.com/Pop/GetSetItems' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' \
  --data 'headingID=<ID>&categoryID=<CAT>&draw=1&start=0&length=25&isPSADNA=false'
```

Compare the row JSON against `normalizePopSetRow`'s expectations
(`SpecID`, `SubjectName`, `CardNumber`, `Variety`, grade columns). The
parser is alias-tolerant, but if keys differ materially, fix
`lib/psa/pop-scrape.ts` + `tests/psa-pop-scrape.test.mjs` (use a REAL
captured row as the fixture), run the tests, commit to the branch,
push. **Create `docs/psa-pop-scrape-notes.md`** recording: TCG
categoryID, example headingIds, a sample row verbatim, cookie/UA
requirements observed, and anything that surprised you. Commit it.

### 2. Swagger check (5 min — could obsolete the scraping)

```bash
curl -s -H "Authorization: Bearer $PSA_API_TOKEN" \
  https://api.psacard.com/publicapi/swagger/docs/v1 | python3 -m json.tool | grep -i '"/publicapi'
```

If an OFFICIAL endpoint lists specs by set (anything like
`GetSpecsBySet`, `GetSetItems`, spec search), STOP and flag it in your
report before investing further in the scrape path — official beats
scraping. Record the full path list in the notes doc either way.

### 3. Merge gate

Migrations + code deploy on merge. Confirm with the owner that the PR
for `claude/happy-archimedes-slu1ux` is open/merged. After merge:
verify the `Supabase Migrations` workflow ran green (GitHub Actions),
and Vercel deployed. Everything below assumes prod schema + code.

### 4. Phase 1 smoke (PR #221's own checklist, if not already done)

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'https://popalpha.ai/api/cron/snapshot-psa-pop?specId=10041062' | python3 -m json.tool
```

Expect `ok:true, snapshotted:1`, and a `psa_spec_pop_snapshots` row
(`source='api'`) for today.

### 5. First matcher run (the 4 existing specs)

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" 'https://popalpha.ai/api/cron/match-psa-specs' | python3 -m json.tool
curl -s -H "Authorization: Bearer $CRON_SECRET" 'https://popalpha.ai/api/cron/match-psa-specs?mode=report' | python3 -m json.tool
```

Predicted outcomes — investigate any deviation:

| spec_id | card | expected |
| --- | --- | --- |
| 10041062 | JP sv4a Mew ex #347 | MATCHED ~0.95 (`DERIVED_CODE_NAME`) |
| 9656727 | Van Gogh Pikachu SVP #085 | queued `LOW_CONFIDENCE_MATCH_BLOCKED` (proposal in metadata) — flips MATCHED after step 6 curation |
| 666080 | 1998 JP Illustrator Pikachu | queued `MISSING_PSA_SET_MAP` (catalog likely has no home — that's correct) |
| 7644607 | Trick or Trade foil pack | queued `NON_CARD_CATEGORY` (it's sealed) |

### 6. Curate + verify

Inspect the queue:

```sql
select m.spec_id, t.description, m.mapping_status, m.match_reason,
       m.match_confidence, m.canonical_slug, m.metadata->>'proposedSlug' as proposed
from psa_spec_card_map m join psa_spec_targets t using (spec_id)
order by m.mapping_status, m.match_reason;
```

For each queued brand worth mapping: confirm the set code against our
catalog (`select set_code, set_name, language from card_printings where
set_name ilike '%...%' group by 1,2,3;`), then upsert a curated row
(curated always beats derived):

```sql
insert into psa_set_map (psa_brand_key, canonical_set_code, canonical_set_name, language, confidence, source, notes)
values ('POKEMON SVP EN-SV BLACK STAR PROMO', '<set_code>', '<set name>', 'EN', 1.0, 'MANUAL', 'curated <date>')
on conflict (psa_brand_key) do update set canonical_set_code = excluded.canonical_set_code,
  canonical_set_name = excluded.canonical_set_name, language = excluded.language,
  confidence = excluded.confidence, source = 'MANUAL', notes = excluded.notes;
```

Re-run the matcher (`?force=1` only if you changed a mapping a MATCHED
spec depends on). **Spot-check every MATCHED spec while the count is
small**: PSA's pop page row (subject/number/variety) vs our card page
`https://popalpha.ai/c/<canonical_slug>` — same card, same variant
family? Then:

```sql
update psa_spec_card_map set verified = true where spec_id in (<checked ids>);
```

### 7. Discovery pilot (one set, end to end)

Seed the page you reconned in step 1:

```sql
insert into psa_pop_set_pages (heading_id, category_id, title, year, language, canonical_set_code, set_confidence, source, notes)
values (<headingId>, <categoryId>, '<exact page title>', '2023', 'JP', 'sv4a_ja', 1.0, 'MANUAL', 'pilot set');
```

```bash
node --experimental-strip-types --loader ./scripts/ts-root-loader.mjs \
  scripts/discover-psa-specs.mjs --headingId=<headingId> --dry-run
```

Sanity-check the JSON (`rows` ≈ `recordsTotal`, subjects/numbers look
like Shiny Treasure ex, spec 10041062 present). Then run without
`--dry-run` and check:

- `psa_spec_targets`: count by source — `pop_scrape` rows landed with
  `fields` + `pop_heading_id`.
- `psa_spec_pop_snapshots`: today's rows with `source='pop_scrape'`.
- `match-psa-specs?mode=report`: most of the set should auto-match at
  ≥0.9 via the page's `canonical_set_code`; read `unmatchedByReason`
  for the rest (JP alt-arts with odd subjects will queue — fine).
- Spot-check 5 random matched specs as in step 6 (verify the SET-level
  mapping carefully once; per-spec checks can then sample).

### 8. Scale deliberately

Seed 5–10 more pages (mix the owner cares about: vintage EN like Base
Set, modern chase sets like Evolving Skies / 151 / Prismatic, top JP
sets), `--pages=5` per run, review the report between batches. Record
each page's headingId in the notes doc — they're permanent identifiers.
Watch for 403/429 signatures; back off rather than retry-hammer.

### 9. Cron scheduling decision (prod egress probe)

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'https://popalpha.ai/api/cron/discover-psa-specs?headingId=<id>&dryRun=1' | python3 -m json.tool
```

- **200 with rows** → Vercel egress passes Cloudflare. Add to
  `vercel.json` crons: `{"path": "/api/cron/discover-psa-specs", "schedule": "40 8 * * *"}`
  on a branch + PR (never direct to main).
- **403 / challenge page** → discovery stays script-driven from your
  machine. Note it in `docs/ROADMAP.md` (Phase 2b row) and consider a
  weekly reminder cadence with the owner.

### 10. Close out

- Update `docs/ROADMAP.md`: Phase 2 → `shipped` once the original
  definition of done holds (every target matched-or-queued — check
  `coveragePct`/`matchRatePct` in `?mode=report` — and the owner/you
  have spot-checked samples); Phase 2b status per step 9's outcome.
- Commit `docs/psa-pop-scrape-notes.md` with: categoryID, headingIds
  seeded, final report JSON, anomalies, and what the next session
  should build (auto-crawl of category browse pages to seed
  `psa_pop_set_pages`; catalog-coverage metric — % of canonical cards
  with ≥1 mapped spec — in report mode).
- Push everything to a branch and tell the owner what changed.

## Known failure modes

- **GetSetItems 403s from curl but works in browser** → Cloudflare
  wants cookies/JS. Try once with browser-copied cookies to confirm the
  diagnosis, record it, and report back — do NOT build evasion.
- **Schema drift in rows** → parser fix in `normalizePopSetRow` (keep
  the raw-row passthrough; snapshots store `raw` verbatim so history
  survives parser bugs).
- **`SUBJECT_MISMATCH` spike on one page's specs** → the page's
  `canonical_set_code` is probably wrong; fix the registry row, re-run
  matcher with `?force=1` for those specs.
- **`supabase db push` drift errors** → read the postmortem first;
  don't run `migration repair --status reverted` on migrations that
  actually executed.
- **Matcher 500s** → `ingest_runs` row has `firstError`; the route also
  logs to Vercel.
