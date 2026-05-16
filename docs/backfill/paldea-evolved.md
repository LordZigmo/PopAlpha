# Paldea Evolved JustTCG Backfill Runbook

This backfill uses the existing PopAlpha cache tables only:

- `card_external_mappings`
- `provider_ingests`
- `provider_raw_payloads`
- `market_latest`
- `price_history_points`
- `variant_metrics`

It does **not** create new `canonical_cards` or `card_printings`.
It stores printing mappings keyed on `printing_id`, not legacy `card_id`.

## Preflight SQL Checks

Apply migrations before the run:

```bash
supabase db push --include-all
```

Required migrations for this backfill:

- `20260301230000_harden_justtcg_mapping_and_history_keys.sql`
- `20260301233000_signal_window_preference.sql`

Verify canonical printings exist for the set and language:

```sql
select
  count(*) as printings_en
from public.card_printings
where language = 'EN'
  and set_name ilike 'Paldea Evolved';
```

Verify canonical cards are complete for those printings:

```sql
select
  count(distinct cp.canonical_slug) as printing_slugs,
  count(distinct cc.slug) as canonical_rows
from public.card_printings cp
left join public.canonical_cards cc
  on cc.slug = cp.canonical_slug
where cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Optional: verify existing JustTCG set mapping:

```sql
select *
from public.provider_set_map
where provider = 'JUSTTCG'
  and provider_set_id in ('paldea-evolved', 'paldea-evolved-pokemon');
```

Verify new indexes exist:

```sql
select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'card_external_mappings_printing_uidx',
    'card_external_mappings_canonical_uidx',
    'price_history_points_provider_variant_ts_window_uidx'
  )
order by indexname;
```

Verify no duplicate printing mappings remain:

```sql
select source, mapping_type, printing_id, count(*)
from public.card_external_mappings
where mapping_type = 'printing'
  and printing_id is not null
group by 1,2,3
having count(*) > 1;
```

If `card_printings` returns `0`, stop and run the canonical import first. This backfill intentionally fails instead of creating canonical rows.

## Entrypoint

Route:

`POST /api/debug/justtcg/backfill-set?set=paldea-evolved&language=EN&aggressive=1&dryRun=1`

Optional operator override:

`POST /api/debug/justtcg/backfill-set?set=paldea-evolved&providerSetId=<justtcg-set-id>&language=EN&aggressive=1&dryRun=1`

Use `providerSetId` when the human set key is not resolving to a usable JustTCG set id.

Auth:

`Authorization: Bearer <CRON_SECRET>`

## Execution Steps

### 1. Dry Run

Use dry run first. This fetches and matches but does not write cache rows.

```bash
curl -X POST "http://localhost:3000/api/debug/justtcg/backfill-set?set=paldea-evolved&language=EN&aggressive=1&dryRun=1" ^
  -H "Authorization: Bearer <CRON_SECRET>"
```

Review:

- `printingsSelected`
- `matchedCount`
- `noMatchCount`
- `hardFailCount`
- `providerWindowUsed`
- `failures`

Interpret failures:

- `NO_PROVIDER_MATCH`: review `sample.local` and `sample.top_rejected_candidates`
- `AMBIGUOUS_PROVIDER_MATCH`: review `sample.topCandidates`
- `PROVIDER_FETCH_FAILED`: the set fetch failed; do not proceed live until resolved
  - if the detail says `JustTCG returned 0 cards for set ...`, the provider set id is currently not usable and the live run should be treated as blocked

Each `NO_PROVIDER_MATCH` sample includes:

- local matching fields used:
  - `card_number`
  - `finish`
  - `name`
- top rejected provider candidates (up to 5)
- explicit rejection reasons such as:
  - `card_number_mismatch`
  - `finish_mismatch`
  - `language_mismatch`
  - `missing_price`

### 2. Live Run

After a clean dry run:

```bash
curl -X POST "http://localhost:3000/api/debug/justtcg/backfill-set?set=paldea-evolved&language=EN&aggressive=1" ^
  -H "Authorization: Bearer <CRON_SECRET>"
```

Expected successful fields:

- `ok: true`
- `matchedCount > 0`
- `mappingUpserts > 0`
- `marketLatestWritten > 0`
- `historyPointsWritten > 0`
- `variantMetricsWritten > 0`

Historical depth behavior:

- if JustTCG accepts `all`, cache rows are written with `source_window='full'`
- if `all` is rejected but `365d` is accepted, cache rows are written with `source_window='365d'`
- in both cases, a derived `30d` subset is also cached for current card-page reads

Timestamp behavior:

- We store exact provider event timestamps, not day-bucketed timestamps.
- JustTCG epochs may arrive in seconds or milliseconds.
- Invalid epochs are rejected if they resolve to:
  - before `2010-01-01`
  - later than `now() + 1 day`

## Post-Run Verification SQL

Get the latest run:

```sql
select id, started_at, ended_at, ok, items_fetched, items_upserted, items_failed, meta
from public.ingest_runs
where job = 'backfill_justtcg_set'
order by started_at desc
limit 1;
```

Verify JUSTTCG mappings exist for Paldea Evolved printings:

```sql
select count(*) as mapping_count
from public.card_external_mappings cem
join public.card_printings cp
  on cp.id = cem.printing_id
where cem.source = 'JUSTTCG'
  and cem.mapping_type = 'printing'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Verify market cache rows:

```sql
select count(*) as market_latest_count
from public.market_latest ml
join public.card_printings cp
  on cp.id = ml.printing_id
where ml.source = 'JUSTTCG'
  and ml.grade = 'RAW'
  and ml.price_type = 'MARKET'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Verify history rows:

```sql
select count(*) as history_count
from public.price_history_points php
join public.card_printings cp
  on php.variant_ref = cp.id::text || '::RAW'
where php.provider = 'JUSTTCG'
  and php.source_window = '30d'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Verify long-window history rows:

```sql
select
  source_window,
  count(*) as point_count
from public.price_history_points php
join public.card_printings cp
  on php.variant_ref = cp.id::text || '::RAW'
where php.provider = 'JUSTTCG'
  and php.source_window in ('full', '365d')
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved'
group by source_window
order by source_window;
```

Earliest and latest timestamp for a sample printing:

```sql
select
  min(ts) as earliest_ts,
  max(ts) as latest_ts,
  count(*) as point_count
from public.price_history_points
where provider = 'JUSTTCG'
  and variant_ref = '<printing_id>::RAW'
  and source_window in ('full', '365d');
```

Verify 3 sampled printings:

```sql
with sample_printings as (
  select id
  from public.card_printings
  where language = 'EN'
    and set_name ilike 'Paldea Evolved'
  order by card_number asc
  limit 3
)
select
  php.variant_ref,
  php.source_window,
  min(php.ts) as earliest_ts,
  max(php.ts) as latest_ts,
  count(*) as point_count
from public.price_history_points php
join sample_printings sp
  on php.variant_ref = sp.id::text || '::RAW'
where php.provider = 'JUSTTCG'
  and php.source_window in ('full', '365d', '30d')
group by php.variant_ref, php.source_window
order by php.variant_ref, php.source_window;
```

Verify printing-backed variant metrics:

```sql
select count(*) as variant_metrics_count
from public.variant_metrics vm
join public.card_printings cp
  on cp.id = vm.printing_id
where vm.provider = 'JUSTTCG'
  and vm.grade = 'RAW'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Verify derived signals were refreshed:

```sql
select count(*) as signals_ready
from public.variant_metrics vm
join public.card_printings cp
  on cp.id = vm.printing_id
where vm.provider = 'JUSTTCG'
  and vm.grade = 'RAW'
  and vm.signals_as_of_ts is not null
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved';
```

Verify which history window the signal engine will use:

```sql
select
  public.preferred_signal_history_window('JUSTTCG', vm.variant_ref) as selected_window,
  count(*) as variant_count
from public.variant_metrics vm
join public.card_printings cp
  on cp.id = vm.printing_id
where vm.provider = 'JUSTTCG'
  and vm.grade = 'RAW'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved'
group by 1
order by 1;
```

Verify how many signals are computed by selected window:

```sql
select
  public.preferred_signal_history_window('JUSTTCG', vm.variant_ref) as selected_window,
  count(*) filter (where vm.signals_as_of_ts is not null) as signals_ready,
  count(*) as total_variants
from public.variant_metrics vm
join public.card_printings cp
  on cp.id = vm.printing_id
where vm.provider = 'JUSTTCG'
  and vm.grade = 'RAW'
  and cp.language = 'EN'
  and cp.set_name ilike 'Paldea Evolved'
group by 1
order by 1;
```

## Rollback (By `ingest_runs.run_id`)

1. Identify the `run_id` from `ingest_runs`.
2. Inspect `ingest_runs.meta.createdMappings` and `provider_ingests` for the affected printings.
3. Roll back only the affected set and provider rows.

Example targeted rollback:

```sql
-- Replace :run_id with the actual UUID and keep the subquery identical across deletes.
with touched as (
  select distinct printing_id
  from public.provider_ingests
  where provider = 'JUSTTCG'
    and job = 'backfill_justtcg_set'
    and ingested_at >= (
      select started_at from public.ingest_runs where id = :run_id
    )
    and ingested_at <= (
      select ended_at from public.ingest_runs where id = :run_id
    )
    and printing_id is not null
)
delete from public.market_latest
where source = 'JUSTTCG'
  and printing_id in (select printing_id from touched);
```

Then:

```sql
with touched as (
  select distinct printing_id::text || '::RAW' as variant_ref
  from public.provider_ingests
  where provider = 'JUSTTCG'
    and job = 'backfill_justtcg_set'
    and ingested_at >= (
      select started_at from public.ingest_runs where id = :run_id
    )
    and ingested_at <= (
      select ended_at from public.ingest_runs where id = :run_id
    )
    and printing_id is not null
)
delete from public.price_history_points
where provider = 'JUSTTCG'
  and variant_ref in (select variant_ref from touched);
```

And:

```sql
with touched as (
  select distinct printing_id
  from public.provider_ingests
  where provider = 'JUSTTCG'
    and job = 'backfill_justtcg_set'
    and ingested_at >= (
      select started_at from public.ingest_runs where id = :run_id
    )
    and ingested_at <= (
      select ended_at from public.ingest_runs where id = :run_id
    )
    and printing_id is not null
)
delete from public.variant_metrics
where provider = 'JUSTTCG'
  and grade = 'RAW'
  and printing_id in (select printing_id from touched);
```

Finally, if needed:

```sql
with touched as (
  select distinct printing_id
  from public.provider_ingests
  where provider = 'JUSTTCG'
    and job = 'backfill_justtcg_set'
    and ingested_at >= (
      select started_at from public.ingest_runs where id = :run_id
    )
    and ingested_at <= (
      select ended_at from public.ingest_runs where id = :run_id
    )
    and printing_id is not null
)
delete from public.card_external_mappings
where source = 'JUSTTCG'
  and mapping_type = 'printing'
  and printing_id in (select printing_id from touched);
```

Audit rows in `provider_ingests`, `provider_raw_payloads`, and `ingest_runs` should generally be kept.
