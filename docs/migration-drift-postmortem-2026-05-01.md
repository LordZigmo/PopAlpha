# Migration Drift Postmortem — 2026-05-01

## What happened

Between 2026-04-18 and 2026-04-30, **35 migrations were applied to prod via the Supabase Dashboard SQL Editor** instead of through the `supabase db push` workflow. Each Dashboard apply recorded a fresh row in `supabase_migrations.schema_migrations` with the apply-time timestamp — not the timestamp on the corresponding file in `supabase/migrations/`. This produced two kinds of divergence:

- **Timestamp drift**: 28 migrations had a local file at one timestamp and a recorded apply at a different (later) timestamp.
- **Lost source-of-truth**: 7 migrations were applied with no corresponding file ever committed to git.

Side effect: `supabase db push` from CI (`.github/workflows/supabase-migrations.yml`) errored out on the drift, so subsequent migrations could only be applied via Dashboard, compounding the problem.

## Why it happened

CI was already broken when the team needed to ship migrations. Dashboard SQL was the unblock-the-feature workaround. The workaround stuck because (a) it kept working in isolation, and (b) the drift error message "remote migration versions not found in local migrations directory" doesn't make the recovery path obvious — the suggested `migration repair --status reverted` call would have *removed* the applied entries from the history table, which is the wrong direction for migrations that genuinely ran.

## What we did to clean up

A throwaway investigation script (`scripts/_drift-investigation.mjs`, removed after this commit) parsed the prod migration history dump and produced a side-by-side diff for every drift entry against any local file with the same name. We walked through each of the 9 content-divergent pairs and chose the canonical SQL per file:

| Bucket | Count | Rule applied |
|---|---|---|
| Content-match | 19 | Local file content kept (richer docs); renamed to remote timestamp. |
| Content-differs — local wins | 6 | Local file content kept; renamed to remote timestamp. Reason: local has correct DDL or necessary `DROP FUNCTION` / `DROP CONSTRAINT` lines that prod ran out-of-band. |
| Content-differs — remote wins (full) | 1 | `card_profiles_refresh_rpc_tiered`: original v1 SQL restored at remote v1 timestamp; v2/v3/v4 ghost SQL restored at their respective ghost timestamps. Local file (which contained v4 logic at v1 timestamp) deleted — content preserved verbatim in the v4 file. |
| Content-differs — remote SQL + local docs | 2 | `daily_top_movers` v1 (with `>= 1` bug) and `phase2a_variant_classifier_and_columns` (with `null → NON_HOLO` divergence). Prod SQL preserved as canonical; local doc headers prepended. |
| Ghosts | 7 | Pure addition — remote SQL written to git for the first time. |

After cleanup, `supabase/migrations/<remote_ts>_<remote_name>.sql` exists for every applied migration with content matching what's running in prod (modulo doc-only differences for the bug-then-fix cases, which are now documented in this postmortem and the file headers).

## Pending work surfaced by the cleanup

While verifying drift was clean, `supabase db push --dry-run --include-all` revealed 11 local-only migrations that had NEVER been applied to prod. Categorized:

**Applied as part of this PR (TestFlight / price coverage critical):**
- `20260416230000_fix_scrydex_literal_in_distinct_on` — fixes the `refresh_card_metrics_for_variants` RPC that has been silently failing since 2026-04-07. The price refresh has been running on the 12h cron backstop only — likely root cause of cards missing `market_price`.
- `20260416234500_card_image_mirror` — mirrored image columns + cron infrastructure.
- `20260417000000_bulk_prune_price_history_points` — batched DELETE RPC for the >90d backlog.
- `20260420150000_index_provider_observation_matches_canonical_slug` — missing FK index that caused `canonical_cards` deletes to time out.
- `20260424000000_phase3_price_snapshots_printing_backfill` — backfills `price_snapshots.printing_id` so card_metrics surfaces price for Phase 2/3-mapped printings.
- `20260424010000_grant_preferred_canonical_raw_printing` — anon EXECUTE grant on the function the canonical view's WHERE clause calls. Without this, **every iOS chart silently 42501s for unauthenticated users**.

**Held in `supabase/migrations/_pending/` for separate review:**
- `20260423000000_phase2b_missing_finish_printings`
- `20260423040000_phase3a_stamp_classifier_and_remap`
- `20260423050000_phase3b_edition_classifier_and_remap`
- `20260427000000_scan_events_multicrop_telemetry`
- `20260427010000_attention_slugs_for_art_crop`
- `20260427020000_attention_slugs_include_labeled`

The Supabase CLI ignores subdirectories under `supabase/migrations/`, so files in `_pending/` are visible in git for review without being applied. To apply: `git mv supabase/migrations/_pending/<file> supabase/migrations/`, then push.

**Deleted as a confirmed duplicate:**
- `20260430030000_card_image_embeddings_pk_model_version` — byte-identical SQL to the already-applied `20260430222858_card_image_embeddings_pk_include_model_version`. Both ship the same `DO $$` PK swap with the same idempotency guard.

## CI workflow change

`.github/workflows/supabase-migrations.yml` now uses `supabase db push --include-all`. Without `--include-all`, the CLI errors when local migrations have older timestamps than the latest remote timestamp — which is exactly the situation that produced this drift. The `--include-all` flag is harmless in steady-state (no out-of-order migrations → same behavior as bare `db push`).

## Going forward

**Don't apply migrations via Dashboard SQL Editor.** If CI is failing, fix CI before applying — silent dashboard applies create exactly this problem. The proper escape hatch is `supabase migration repair` (carefully) or a dedicated branch + manual `supabase db push` with the prod password.

**Three known divergences worth a follow-up migration once someone has time:**

1. **`normalize_scrydex_finish` null/empty token behavior** (in `phase2a_variant_classifier_and_columns`). Local design doc says `NULL → NULL` (caller must source finish from `card_printings`); prod is doing `NULL → 'NON_HOLO'`. Decide which is correct and write a follow-up migration if the local design intent was right. See diff in this PR's `phase2a_variant_classifier_and_columns.sql` header.

2. **`card_profiles_refresh_rpc_tiered` v1→v4 iterations** (`20260429004328` through `20260429005519`). Four versions of the same RPC in 23 minutes suggest rapid hot-fixing under pressure. The v4 logic that ships in prod filters `WHERE cm.market_price IS NOT NULL` — cards without market_price are invisible to the refresh path. Whoever owns the price-coverage investigation should read all four versions, in `supabase/migrations/`, and decide whether v4 is the keeper or a v5 is needed.

3. **`daily_momentum_rails` and `daily_top_movers` schema dependencies**. The applied SQL (now restored in git from local) requires `DROP FUNCTION` for signature changes and `DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT` for kind-check expansion. Prod got those out-of-band. Future replays on a fresh DB now work because the local SQL had them — but if any other migration in the cluster also relied on out-of-band tweaks, replays will fail there. The cleanup audit found none, but a clean `supabase db reset` against the linked DB would be the way to verify.

## Files

- This postmortem: `docs/migration-drift-postmortem-2026-05-01.md`
- The 35 restored migration files: `supabase/migrations/<remote_ts>_<remote_name>.sql`
- Held-back migrations: `supabase/migrations/_pending/`
- Workflow change: `.github/workflows/supabase-migrations.yml`
