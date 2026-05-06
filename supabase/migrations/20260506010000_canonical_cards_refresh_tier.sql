-- Phase 1 of "Tiered Refresh + UX Fallbacks" plan (2026-05-06).
--
-- Adds a per-card classification of how often the card actually trades,
-- so downstream pipeline + UX work can branch on it. This migration is
-- pure plumbing: nothing else uses the new column yet, the partial
-- index is empty until backfill, and the RPC is callable but not yet
-- wired to a cron. Phases 2-4 of the plan layer behavior on top.
--
-- Why we need this
-- -----------------
-- Catalog audit (2026-05-05) found 99.7% of cards trade <= 6 days/month
-- and 19% had zero trades in the last 30 days. The pipeline today
-- treats every card as needing 24h refresh, which has driven repeated
-- CPU incidents and chronic gate-trip on compute_daily_top_movers.
-- A tier label lets us refresh hot cards on the cadence they need and
-- skip downstream write amplification (price_history_points,
-- variant_metrics) for sparse / dormant cards.
--
-- Tier definitions
-- ----------------
--   hot      observed_days_7d >= 4                       (~300 cards expected)
--   warm     observed_days_30d >= 6                      (small count)
--   sparse   observed_days_180d >= 1                     (most of the 16k)
--   dormant  no match in 180d OR mapping_status != 'MATCHED'  (~3.5k)
--
-- Source: provider_observation_matches.updated_at (small, indexed table)
-- joined to provider_card_map for mapping_status. We deliberately do
-- NOT source the count from price_history_points — that's the 13M-row
-- hot path the audit identified as the CPU sink.

alter table public.canonical_cards
  add column if not exists refresh_tier text not null default 'unknown',
  add column if not exists refresh_tier_computed_at timestamptz;

alter table public.canonical_cards
  drop constraint if exists canonical_cards_refresh_tier_check;
alter table public.canonical_cards
  add constraint canonical_cards_refresh_tier_check
  check (refresh_tier in ('unknown', 'hot', 'warm', 'sparse', 'dormant'));

-- Partial index for the planner — `where refresh_tier = 'hot'` is the
-- hot path Phase 3+4 will use to filter sets and cards. Keeping it
-- partial means the index stays tiny (~300 rows after backfill).
create index if not exists canonical_cards_refresh_tier_hot_idx
  on public.canonical_cards (slug)
  where refresh_tier = 'hot';

-- Helpful for the recompute job's update path — finding rows whose
-- stored tier differs from recommended. Small table (~19.6k rows)
-- but we'll be reading the column on every observation insert in
-- Phase 3, so the index pays for itself.
create index if not exists canonical_cards_refresh_tier_idx
  on public.canonical_cards (refresh_tier);

-- compute_refresh_tier()
--
-- Returns a recommendation per canonical_slug. Idempotent on data —
-- two calls in a row return the same result if no observations
-- arrived between them. Caller (the recompute cron) decides whether
-- to apply the recommendations to canonical_cards.refresh_tier.
--
-- Returns one row per canonical_slug, including ones currently labelled
-- 'unknown' or 'dormant' — that's how transitions are detected.
-- The set is small (~19.6k rows) so we return everything; the
-- recompute job filters to transitions on its end.

create or replace function public.compute_refresh_tier()
returns table (
  canonical_slug text,
  observed_days_7d integer,
  observed_days_30d integer,
  observed_days_180d integer,
  recommended_tier text
)
language sql
stable
security definer
set statement_timeout to '60s'
set search_path to 'public'
as $$
  with match_density as (
    -- One row per (canonical_slug, observed_day) for the last 180 days.
    -- DISTINCT collapses multiple within-day matches to one.
    select distinct
      pcm.canonical_slug,
      (m.updated_at at time zone 'UTC')::date as observed_day,
      m.updated_at
    from public.provider_observation_matches m
    join public.provider_card_map pcm
      on pcm.provider = m.provider
     and pcm.provider_card_id = m.provider_card_id
     and pcm.provider_variant_id = m.provider_variant_id
     and pcm.mapping_status = 'MATCHED'
    where m.match_status = 'MATCHED'
      and m.updated_at >= now() - interval '180 days'
      and pcm.canonical_slug is not null
  ),
  per_slug as (
    select
      canonical_slug,
      count(distinct observed_day) filter (where updated_at >= now() - interval '7 days')::int as observed_days_7d,
      count(distinct observed_day) filter (where updated_at >= now() - interval '30 days')::int as observed_days_30d,
      count(distinct observed_day) filter (where updated_at >= now() - interval '180 days')::int as observed_days_180d
    from match_density
    group by canonical_slug
  )
  select
    cc.slug as canonical_slug,
    coalesce(ps.observed_days_7d, 0) as observed_days_7d,
    coalesce(ps.observed_days_30d, 0) as observed_days_30d,
    coalesce(ps.observed_days_180d, 0) as observed_days_180d,
    case
      when coalesce(ps.observed_days_7d, 0) >= 4 then 'hot'
      when coalesce(ps.observed_days_30d, 0) >= 6 then 'warm'
      when coalesce(ps.observed_days_180d, 0) >= 1 then 'sparse'
      else 'dormant'
    end as recommended_tier
  from public.canonical_cards cc
  left join per_slug ps on ps.canonical_slug = cc.slug;
$$;

revoke all on function public.compute_refresh_tier() from public, anon, authenticated;
grant execute on function public.compute_refresh_tier() to service_role;

-- apply_refresh_tier_recompute()
--
-- The cron's entry point. Calls compute_refresh_tier(), updates
-- canonical_cards rows whose stored tier differs from recommended,
-- and returns a summary JSON for cron observability.
--
-- Update is row-level (not bulk) but small: typical week-over-week
-- transitions should be in the hundreds, not thousands. Whole-table
-- backfill (first run) updates ~19.6k rows once — fine on a weekly
-- cadence with statement_timeout = 5min.

create or replace function public.apply_refresh_tier_recompute()
returns jsonb
language plpgsql
security definer
set statement_timeout to '300s'
set search_path to 'public'
as $$
declare
  _transitions int := 0;
  _hot int;
  _warm int;
  _sparse int;
  _dormant int;
begin
  with recommended as (
    select * from public.compute_refresh_tier()
  ),
  changed as (
    update public.canonical_cards cc
    set
      refresh_tier = r.recommended_tier,
      refresh_tier_computed_at = now()
    from recommended r
    where cc.slug = r.canonical_slug
      and cc.refresh_tier is distinct from r.recommended_tier
    returning 1
  )
  select count(*) into _transitions from changed;

  -- Always touch the timestamp on whole-table refresh so we know the
  -- recompute ran even if no transitions happened.
  update public.canonical_cards
    set refresh_tier_computed_at = now()
    where refresh_tier_computed_at is null;

  select
    count(*) filter (where refresh_tier = 'hot'),
    count(*) filter (where refresh_tier = 'warm'),
    count(*) filter (where refresh_tier = 'sparse'),
    count(*) filter (where refresh_tier = 'dormant')
  into _hot, _warm, _sparse, _dormant
  from public.canonical_cards;

  return jsonb_build_object(
    'computed_at', now(),
    'transitions', _transitions,
    'distribution', jsonb_build_object(
      'hot', coalesce(_hot, 0),
      'warm', coalesce(_warm, 0),
      'sparse', coalesce(_sparse, 0),
      'dormant', coalesce(_dormant, 0)
    )
  );
end;
$$;

revoke all on function public.apply_refresh_tier_recompute() from public, anon, authenticated;
grant execute on function public.apply_refresh_tier_recompute() to service_role;
