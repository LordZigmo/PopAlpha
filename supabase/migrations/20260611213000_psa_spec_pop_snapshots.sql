-- PSA population snapshot pipeline (2026-06-11).
--
-- PSA's official Public API exposes per-spec population:
--   GET /publicapi/pop/GetPSASpecPopulation/{specID}
-- returning the full grade distribution (Auth, 1..10 incl. halves and
-- qualifiers). Population history cannot be backfilled from any grader —
-- everyone in the industry builds "pop over time" by snapshotting daily
-- and diffing (GemRate states this outright) — so the value of this
-- pipeline compounds from the day it ships. These tables are the
-- raw-ingest leg; derived diffs/charts come later.
--
-- SpecIDs arrive organically: every PSA cert lookup (slab scan) carries
-- the card's SpecID in its payload. The seed below harvests every SpecID
-- we've already collected, and /api/psa/cert upserts new ones on each
-- fresh lookup. The snapshot cron walks targets in a budgeted rotation
-- (PSA free tier is ~100 calls/day, shared with cert lookups).

create table if not exists public.psa_spec_targets (
  spec_id integer primary key,
  description text,
  -- Optional link into our catalog once a spec is matched to a card.
  canonical_slug text,
  -- 'cert_scan' (harvested from a cert lookup), 'seed' (this migration),
  -- or 'manual'.
  source text not null default 'cert_scan',
  -- Higher = snapshot earlier within the daily budget.
  priority integer not null default 0,
  active boolean not null default true,
  last_snapshot_on date,
  created_at timestamptz not null default now()
);

create index if not exists psa_spec_targets_rotation_idx
  on public.psa_spec_targets (active, last_snapshot_on asc nulls first, priority desc);

create table if not exists public.psa_spec_pop_snapshots (
  spec_id integer not null,
  -- One row per spec per UTC day; the cron upserts so a manual re-run
  -- refreshes today's row instead of duplicating it.
  captured_on date not null,
  description text,
  total integer,
  auth_count integer,
  -- The PSAPop object verbatim (Grade1..Grade10 + halves + qualifiers).
  grade_counts jsonb not null,
  -- Full API payload for forward-compat reparsing.
  raw jsonb not null,
  created_at timestamptz not null default now(),
  primary key (spec_id, captured_on)
);

-- Server-only tables: RLS on with no policies — anon/authed clients get
-- nothing, the service role bypasses.
alter table public.psa_spec_targets enable row level security;
alter table public.psa_spec_pop_snapshots enable row level security;

-- Seed targets from every cert lookup we've already performed. Both the
-- lookup cache (data = {parsed, raw}) and the immutable snapshots
-- (raw = payload) carry PSACert.SpecID.
insert into public.psa_spec_targets (spec_id, description, source)
select distinct on (spec_id) spec_id, description, 'seed'
from (
  select
    (data->'raw'->'PSACert'->>'SpecID')::int as spec_id,
    nullif(concat_ws(' ',
      data->'raw'->'PSACert'->>'Year',
      data->'raw'->'PSACert'->>'Brand',
      data->'raw'->'PSACert'->>'CardNumber',
      data->'raw'->'PSACert'->>'Subject',
      data->'raw'->'PSACert'->>'Variety'
    ), '') as description
  from public.psa_cert_cache
  where data->'raw'->'PSACert'->>'SpecID' ~ '^[0-9]+$'
  union all
  select
    (raw->'PSACert'->>'SpecID')::int as spec_id,
    nullif(concat_ws(' ',
      raw->'PSACert'->>'Year',
      raw->'PSACert'->>'Brand',
      raw->'PSACert'->>'CardNumber',
      raw->'PSACert'->>'Subject',
      raw->'PSACert'->>'Variety'
    ), '') as description
  from public.psa_cert_snapshots
  where raw->'PSACert'->>'SpecID' ~ '^[0-9]+$'
) harvested
where spec_id is not null and spec_id > 0
on conflict (spec_id) do nothing;

comment on table public.psa_spec_targets is
  'Rotation list for the PSA population snapshot cron (snapshot-psa-pop). SpecIDs harvested from cert lookups; one PSA API call per spec per snapshot.';
comment on table public.psa_spec_pop_snapshots is
  'Daily per-spec PSA population snapshots from GetPSASpecPopulation. History is built by diffing consecutive captured_on rows — it can never be backfilled, only accumulated.';
