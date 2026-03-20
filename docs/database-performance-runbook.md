# Database Performance Runbook

This runbook packages the March 10, 2026 database audit into concrete rollout,
retention, and follow-up steps.

Related artifacts:

- `supabase/migrations/20260310130000_price_history_points_maintenance.sql`
- `supabase/migrations/20260310143000_provider_raw_payload_lineages.sql`
- `supabase/migrations/20260310144000_provider_normalized_observations_lineage.sql`
- `supabase/migrations/20260310145000_provider_raw_payload_retention_fk.sql`
- `scripts/run-refresh-rpc-benchmarks.mjs`
- `sql/ops/refresh-rpc-benchmarks.sql`

## `price_history_points` Rollout

### What the migration does

- Drops `price_history_points_provider_variant_ts_window_uidx` only after
  confirming that the non-partial replacement
  `price_history_points_provider_variant_ref_ts_window_uidx` exists.
- Sets lower autovacuum/analyze thresholds on `price_history_points`.
- Runs `ANALYZE public.price_history_points` immediately after the settings
  change so planner stats do not stay stale until the next autovacuum cycle.

### Preflight

Run these checks before applying the migration to prod:

```sql
select
  indexrelname,
  idx_scan
from pg_stat_user_indexes
where schemaname = 'public'
  and relname = 'price_history_points'
  and indexrelname in (
    'price_history_points_provider_variant_ts_window_uidx',
    'price_history_points_provider_variant_ref_ts_window_uidx'
  )
order by indexrelname;
```

```sql
select
  c.relname as index_name,
  pg_size_pretty(pg_relation_size(c.oid)) as index_size
from pg_class c
join pg_namespace n
  on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'price_history_points_provider_variant_ts_window_uidx',
    'price_history_points_provider_variant_ref_ts_window_uidx'
  )
order by c.relname;
```

```sql
select
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze,
  n_live_tup,
  n_dead_tup
from pg_stat_user_tables
where schemaname = 'public'
  and relname = 'price_history_points';
```

```sql
select
  pid,
  state,
  wait_event_type,
  wait_event,
  now() - query_start as age,
  query
from pg_stat_activity
where datname = current_database()
  and state <> 'idle'
order by query_start asc;
```

Operational notes:

- Run the migration in a low-traffic window. The drop is not `CONCURRENTLY`
  because Supabase migrations run in a transaction.
- If any long-running ingest/backfill job is active, wait for it to finish.
- Capture a baseline with `npx supabase inspect db outliers`,
  `npx supabase inspect db index-stats`, and
  `npx supabase inspect db vacuum-stats`.

### Apply

```bash
supabase db push --include-all
```

### Postflight Verification

Confirm the old index is gone, the replacement remains, and the table options
are set:

```sql
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'price_history_points'
  and indexname like 'price_history_points_provider_variant%';
```

```sql
select
  reloptions
from pg_class
where oid = 'public.price_history_points'::regclass;
```

```sql
select
  last_analyze,
  last_autoanalyze,
  n_live_tup,
  n_dead_tup
from pg_stat_user_tables
where schemaname = 'public'
  and relname = 'price_history_points';
```

```sql
select
  indexrelname,
  idx_scan
from pg_stat_user_indexes
where schemaname = 'public'
  and relname = 'price_history_points'
order by idx_scan desc, indexrelname asc;
```

Expected outcomes:

- `price_history_points_provider_variant_ts_window_uidx` is absent.
- `price_history_points_provider_variant_ref_ts_window_uidx` is still present.
- `reloptions` includes the new autovacuum/analyze thresholds.
- `last_analyze` is refreshed during the migration.

### Rollback

If the old partial index is needed again, recreate it outside the migration
transaction:

```sql
create unique index concurrently if not exists price_history_points_provider_variant_ts_window_uidx
  on public.price_history_points (provider, variant_ref, ts, source_window)
  where variant_ref like '%::%';
```

Then reset table-local autovacuum settings if needed:

```sql
alter table public.price_history_points reset (
  autovacuum_enabled,
  autovacuum_vacuum_scale_factor,
  autovacuum_vacuum_threshold,
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_vacuum_insert_threshold,
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
```

## `provider_raw_payloads` Retention Strategy

### Current constraint

Direct deletes are not safe yet for referenced payloads.

`public.provider_normalized_observations.provider_raw_payload_id` is:

- `NOT NULL`
- a foreign key to `public.provider_raw_payloads(id)`
- defined with `ON DELETE CASCADE`

That means deleting referenced raw payload rows would also delete normalized
observations and then cascade into `provider_observation_matches`.

### Stage 0: Safe actions now

1. Keep the existing request/response dedupe path.
   - `provider_raw_payloads_request_response_uidx` already removes identical
     request/response pairs.
2. Delete only unreferenced payloads in small batches.
   - These are rows with no matching `provider_normalized_observations`.
3. Measure storage by provider and endpoint before deleting anything older than
   the recent working window.

Storage audit query:

```sql
select
  provider,
  endpoint,
  count(*) as row_count,
  pg_size_pretty(sum(pg_column_size(response)::bigint)) as approx_response_bytes,
  min(fetched_at) as oldest_fetched_at,
  max(fetched_at) as newest_fetched_at
from public.provider_raw_payloads
group by provider, endpoint
order by sum(pg_column_size(response)::bigint) desc;
```

Safe no-reference purge batch:

```sql
with doomed as (
  select p.id
  from public.provider_raw_payloads p
  where p.fetched_at < now() - interval '14 days'
    and not exists (
      select 1
      from public.provider_normalized_observations o
      where o.provider_raw_payload_id = p.id
    )
  order by p.fetched_at asc, p.id asc
  limit 5000
)
delete from public.provider_raw_payloads p
using doomed d
where p.id = d.id;
```

Run the batch repeatedly until it returns `DELETE 0`.

### Stage 1: Decouple lineage from raw JSON

Before any retention policy touches referenced payloads, keep these metadata
fields outside the raw JSON row:

- `provider`
- `endpoint`
- `params`
- `request_hash`
- `response_hash`
- `status_code`
- `fetched_at`

Implemented schema set:

1. `20260310143000_provider_raw_payload_lineages.sql`
   - Adds `public.provider_raw_payload_lineages`.
   - Preserves request metadata only, not the large `response` JSON.
   - Adds `public.ensure_provider_raw_payload_lineage(...)` for future writes.
2. `20260310144000_provider_normalized_observations_lineage.sql`
   - Adds `provider_raw_payload_lineage_id` to
     `public.provider_normalized_observations`.
   - Backfills lineage rows for all referenced raw payloads.
   - Adds a trigger so current normalizers can keep writing only
     `provider_raw_payload_id` while the lineage FK is filled automatically.
3. `20260310145000_provider_raw_payload_retention_fk.sql`
   - Replaces `ON DELETE CASCADE` on `provider_raw_payload_id` with
     `ON DELETE SET NULL`.
   - Drops the `NOT NULL` requirement from `provider_raw_payload_id`.

Rollout notes:

1. Apply the migration set before any purge of referenced payloads.
2. The trigger keeps older writer code working during rollout, but the repo now
   updates raw normalizers to send `provider_raw_payload_lineage_id`
   explicitly and to conflict on the lineage key.
3. After deploying the updated normalizers, the next cleanup is dropping the
   old `provider_raw_payload_id` conflict target/index once it is confirmed
   unused.
4. Only then start deleting referenced raw payload rows in batches.

### Stage 2: Steady-state retention after decoupling

Recommended policy once Stage 1 is done:

- Keep all payloads in Postgres for 30 days.
- Keep non-200 payloads in Postgres for 180 days.
- Archive payload JSON older than 30 days to object storage as compressed JSONL
  partitioned by `provider/date`.
- Keep only metadata/lineage rows in Postgres beyond 30 days.
- Purge archived payload metadata entirely after 365 days unless it is tied to
  a live incident or an active backfill investigation.

### Stage 3: Batch purge after archive

After lineage is decoupled and archives are confirmed:

```sql
with archived as (
  select p.id
  from public.provider_raw_payloads p
  where p.fetched_at < now() - interval '30 days'
    and p.status_code between 200 and 299
  order by p.fetched_at asc, p.id asc
  limit 5000
)
delete from public.provider_raw_payloads p
using archived a
where p.id = a.id;
```

Do not use this purge until the Stage 1 schema work is complete.

## Refresh RPC Benchmarks And EXPLAIN Follow-Up

Use `scripts/run-refresh-rpc-benchmarks.mjs` for live RPC timing checks and
`sql/ops/refresh-rpc-benchmarks.sql` for planner-level EXPLAIN follow-up.

The benchmark coverage is:

- `refresh_card_metrics_for_variants`
- `refresh_price_changes_for_cards`
- `refresh_card_market_confidence_for_cards`
- `refresh_canonical_raw_provider_parity_for_cards`

Recommended benchmark cohorts:

- `25` slugs: operator sanity check
- `100` slugs: normal targeted refresh batch
- `400` slugs: upper bound used by `scripts/refresh-market-rollups-batched.mjs`

Live RPC timing:

```bash
node --env-file=.env.local scripts/run-refresh-rpc-benchmarks.mjs --sizes=25,100,400
```

Capture the surrounding database state with:

```bash
npx supabase inspect db outliers
```

```bash
npx supabase inspect db calls
```

```bash
npx supabase inspect db index-stats
```

Focus areas for the EXPLAIN follow-up:

- `refresh_card_metrics_for_variants`
  - `price_snapshots` windowing and `history_counts`
- `refresh_price_changes_for_cards`
  - `price_history_points` scans, provider selection, and hourly rollups
- `refresh_card_market_confidence_for_cards`
  - `provider_counts` over 7-day snapshot rows
- `refresh_canonical_raw_provider_parity_for_cards`
  - `provider_observation_matches` to `provider_normalized_observations` join

Success criteria for the follow-up:

- `price_history_points` plans favor the remaining live indexes.
- `refresh_price_changes_for_cards` total runtime drops or stays flat after the
  index cleanup.
- `refresh_card_metrics_for_variants` and
  `refresh_card_market_confidence_for_cards` keep buffer reads bounded as cohort
  size scales from `25` to `400`.
- `refresh_canonical_raw_provider_parity_for_cards` does not become the new top
  outlier after `price_history_points` is tuned.
