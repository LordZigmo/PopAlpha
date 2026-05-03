-- 20260502020000_touch_verified_snapshots_observation_anchor_guard.sql
--
-- supersedes: 20260419205250_touch_verified_snapshots.sql
--
-- Tightens public.touch_verified_snapshots so it only refreshes
-- price_snapshots rows that still have a matching live upstream observation
-- in provider_normalized_observations.
--
-- Why this exists
-- ---------------
-- A legacy ingestion path (now removed) synthesized "raw" price_snapshots
-- rows from graded data — e.g. when Scrydex didn't return a raw NM price
-- for the :normal variant of a sparsely-traded promo, the synthesis rule
-- copied the PSA G9 graded price and wrote it into a price_snapshots row
-- with grade='RAW' and a provider_ref stripped of the ::GRADED:: suffix.
-- The synthesis code is gone but the rows persisted.
--
-- Migration 20260419205250 added touch_verified_snapshots() to keep snapshots
-- "fresh" when Scrydex returns dedup'd / unchanged data on a poll. The RPC
-- picks the latest snapshot per (canonical_slug, provider_ref, grade) and
-- bumps its observed_at to now(). It does this WITHOUT validating that the
-- snapshot still corresponds to anything Scrydex is actually sending.
-- Result: legacy phantom rows live forever, perpetually treated as
-- "verified just now" by every consumer that filters on observed_at.
--
-- Concrete failure surfaced 2026-05-02:
--   bw-black-star-promos-bw28-tropical-beach  (Tropical Beach BW28)
--   actual market raw NM ≈ $725; card_metrics showed $1,609.62 = exactly
--   the PSA G9 graded comp Scrydex was returning at the time the synthesis
--   code last ran. provider_normalized_observations had only graded
--   entries for the :normal variant; no raw observation existed for it,
--   ever, in the recent window. The phantom price_snapshots row was the
--   sole source of card_metrics.market_price for the canonical RAW row.
--
-- Fix
-- ---
-- Add an observation-anchor guard: a snapshot can only be touched if a
-- corresponding row exists in provider_normalized_observations within the
-- last 14 days, matching on (provider, provider_variant_id). The match
-- recovers provider_variant_id from the snapshot's provider_ref, which is
-- shaped `<provider lower>:<provider_variant_id>` (see
-- buildProviderRef in lib/backfill/provider-observation-timeseries.ts).
--
-- Behaviour after this migration:
--   - Live snapshots backed by a real recent observation: touched as before.
--   - Orphaned legacy phantoms: skipped. Their observed_at naturally ages
--     past the 72h freshness filters in lib/data/homepage.ts and
--     refresh_card_metrics, so they stop participating in canonical
--     market_price and the homepage rails.
--   - The orphan count is returned in the result jsonb so the cron can
--     surface it in logs ("snapshot_orphans_skipped") and we can detect
--     a regression that resurrects synthesis.
--
-- Note: this migration ONLY fixes the keep-alive path. Existing phantoms
-- that have already been "touched" today will keep their fresh observed_at
-- until the next refresh-card-metrics cycle clears them naturally. For
-- targeted cleanup before then, see the audit query in the playbook entry.

create or replace function public.touch_verified_snapshots(
  p_provider         text,
  p_provider_set_id  text,
  p_verified_at      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set statement_timeout = '60s'
set search_path = public
as $$
declare
  _snapshots_touched int;
  _rollups_queued    int;
  _orphans_skipped   int;
begin
  with set_slugs as (
    select distinct canonical_slug
    from provider_card_map
    where provider = p_provider
      and provider_set_id = p_provider_set_id
      and canonical_slug is not null
  ),
  candidate_snapshots as (
    select distinct on (ps.canonical_slug, ps.provider_ref, ps.grade)
      ps.id,
      ps.provider,
      ps.provider_ref
    from price_snapshots ps
    join set_slugs ss on ss.canonical_slug = ps.canonical_slug
    where ps.provider = p_provider
      and ps.observed_at < p_verified_at - interval '1 minute'
    order by ps.canonical_slug, ps.provider_ref, ps.grade,
             ps.observed_at desc, ps.id desc
  ),
  -- Observation anchor: a snapshot is only "verified current" if Scrydex
  -- has actually returned a matching observation in the recent window.
  -- The provider_ref encodes provider_variant_id verbatim, prefixed by
  -- the provider name lowercased, so we reconstruct the join key.
  anchored_snapshots as (
    select cs.id
    from candidate_snapshots cs
    where exists (
      select 1
      from provider_normalized_observations o
      where o.provider = cs.provider
        and cs.provider_ref = format('%s:%s', lower(o.provider), o.provider_variant_id)
        and o.observed_at >= p_verified_at - interval '14 days'
    )
  ),
  orphan_snapshots as (
    select cs.id
    from candidate_snapshots cs
    where not exists (
      select 1
      from provider_normalized_observations o
      where o.provider = cs.provider
        and cs.provider_ref = format('%s:%s', lower(o.provider), o.provider_variant_id)
        and o.observed_at >= p_verified_at - interval '14 days'
    )
  ),
  touched as (
    update public.price_snapshots ps
    set observed_at = p_verified_at
    from anchored_snapshots a
    where ps.id = a.id
    returning ps.canonical_slug
  ),
  touched_slugs as (
    select distinct canonical_slug from touched
  ),
  queued as (
    insert into public.pending_rollups
      (canonical_slug, variant_ref, provider, grade, queued_at)
    select distinct
      vm.canonical_slug,
      vm.variant_ref,
      vm.provider,
      vm.grade,
      p_verified_at
    from public.variant_metrics vm
    join touched_slugs ts on ts.canonical_slug = vm.canonical_slug
    where vm.provider = p_provider
    on conflict (canonical_slug, variant_ref, provider, grade) do update
      set queued_at = excluded.queued_at
    returning 1
  )
  select
    (select count(*) from touched),
    (select count(*) from queued),
    (select count(*) from orphan_snapshots)
  into _snapshots_touched, _rollups_queued, _orphans_skipped;

  return jsonb_build_object(
    'snapshots_touched',        coalesce(_snapshots_touched, 0),
    'rollups_queued',           coalesce(_rollups_queued, 0),
    'snapshot_orphans_skipped', coalesce(_orphans_skipped, 0),
    'provider',                 p_provider,
    'provider_set_id',          p_provider_set_id,
    'verified_at',              p_verified_at
  );
end;
$$;

revoke all on function public.touch_verified_snapshots(text, text, timestamptz)
  from public, anon, authenticated;
