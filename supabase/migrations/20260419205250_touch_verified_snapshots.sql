-- 20260419190000_touch_verified_snapshots.sql
--
-- Adds touch_verified_snapshots(provider, provider_set_id) RPC.
--
-- Context: the Scrydex ingest path hashes (request, response) and dedupes
-- identical fetches against provider_raw_payloads_request_response_uidx.
-- When Scrydex returns unchanged data for a "stable" set (no recent price
-- movement), the ingest short-circuits — no new raw_payload, no normalize,
-- no new price_snapshot, no rollup. The card's public_card_metrics
-- .market_price_as_of stays frozen at the last time Scrydex actually
-- reported a different price, even though we're successfully polling every
-- 6 hours.
--
-- Symptom observed 2026-04-19: fresh_24h stalled at ~14k of 19.4k
-- addressable (72%). Sets with stable prices (Ascended Heroes, Paldean
-- Fates, Twilight Masquerade, etc.) showed 100% of cards in the 24-48h
-- bucket despite 3 successful jobs per 24h.
--
-- This RPC, called by the ingest code when it detects a dedup hit, does:
--   1. Finds every canonical_slug mapped to the provider_set_id
--   2. For each (slug, provider_ref, grade), identifies the LATEST
--      price_snapshot row
--   3. UPDATEs its observed_at to now() (or caller-provided p_verified_at)
--   4. Queues matching variant_metrics keys to pending_rollups so the
--      drain picks up the fresh timestamp
--
-- Semantic shift: observed_at now means "last time we verified this price
-- is still current" rather than "when Scrydex observed it". The row's id
-- and original snapshot data preserve the change-event history.

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
begin
  -- Build the set of snapshot ids to touch + variant keys to enqueue in a
  -- single CTE chain so everything runs in one transaction and we return
  -- consistent counts.
  with set_slugs as (
    select distinct canonical_slug
    from provider_card_map
    where provider = p_provider
      and provider_set_id = p_provider_set_id
      and canonical_slug is not null
  ),
  latest_per_variant as (
    select distinct on (ps.canonical_slug, ps.provider_ref, ps.grade)
      ps.id
    from price_snapshots ps
    join set_slugs ss on ss.canonical_slug = ps.canonical_slug
    where ps.provider = p_provider
      and ps.observed_at < p_verified_at - interval '1 minute'
    order by ps.canonical_slug, ps.provider_ref, ps.grade,
             ps.observed_at desc, ps.id desc
  ),
  touched as (
    update public.price_snapshots ps
    set observed_at = p_verified_at
    from latest_per_variant lpv
    where ps.id = lpv.id
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
  select (select count(*) from touched),
         (select count(*) from queued)
  into _snapshots_touched, _rollups_queued;

  return jsonb_build_object(
    'snapshots_touched', coalesce(_snapshots_touched, 0),
    'rollups_queued',    coalesce(_rollups_queued, 0),
    'provider',          p_provider,
    'provider_set_id',   p_provider_set_id,
    'verified_at',       p_verified_at
  );
end;
$$;

revoke all on function public.touch_verified_snapshots(text, text, timestamptz)
  from public, anon, authenticated;
