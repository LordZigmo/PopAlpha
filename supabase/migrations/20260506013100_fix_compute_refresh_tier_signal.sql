-- supersedes: 20260506010000_canonical_cards_refresh_tier.sql
--
-- Phase 1 follow-up: replace compute_refresh_tier() with a body that
-- uses a proper price-change signal instead of match.updated_at.
--
-- The 20260506010000 version sourced "observed days" from
-- provider_observation_matches.updated_at, which I assumed correlated
-- with new price observations. It does not — match.updated_at also
-- gets touched by re-validation passes, so backfill produced 19,581
-- cards classified 'hot' (84% of catalog) when the audit math
-- expected ~300-1500.
--
-- Calibration after this migration (2026-05-06 backfill):
--   hot     1,526   variant_metrics.provider_price_changes_count_30d ≥ 3
--   warm    9,193   1-2 price changes in 30d
--   sparse  8,938   0 price changes but at least one snapshot in 30d
--   dormant 3,735   no SCRYDEX price_snapshot in 30d (matches the audit's
--                   "ZERO trades in last 30d" cohort exactly)
--
-- Why this signal: Scrydex's per-set fetch writes a snapshot row even
-- when the price didn't move, so snapshot density alone classified
-- nearly every card as active. provider_price_changes_count_30d
-- (already aggregated by the variant_metrics job) is the right
-- discriminator — it counts distinct PRICE values seen in 30d, which
-- is what "trades actively" means in this catalog.
--
-- The applied function was patched directly in prod via
-- supabase db query at ~2026-05-06 01:31 UTC to unblock the Phase 1
-- backfill. This migration formalizes that patch so a fresh-DB replay
-- arrives at the same body.
--
-- Returns shape changed (different column set) so we DROP first; the
-- only caller is apply_refresh_tier_recompute() which references
-- r.canonical_slug + r.recommended_tier — both still present.

drop function if exists public.compute_refresh_tier();

create or replace function public.compute_refresh_tier()
returns table (
  canonical_slug text,
  max_changes_30d integer,
  has_30d_obs boolean,
  recommended_tier text
)
language sql
stable
security definer
set statement_timeout to '180s'
set search_path to 'public'
as $func$
  with per_slug as (
    select
      cc.slug,
      coalesce(max(vm.provider_price_changes_count_30d), 0)::int as max_changes_30d,
      exists(
        select 1 from public.price_snapshots ps
        where ps.canonical_slug = cc.slug
          and ps.provider = 'SCRYDEX'
          and ps.observed_at >= now() - interval '30 days'
      ) as has_30d_obs
    from public.canonical_cards cc
    left join public.variant_metrics vm
      on vm.canonical_slug = cc.slug
     and vm.provider = 'SCRYDEX'
     and vm.grade = 'RAW'
    group by cc.slug
  )
  select
    slug as canonical_slug,
    max_changes_30d,
    has_30d_obs,
    case
      when max_changes_30d >= 3 then 'hot'
      when max_changes_30d between 1 and 2 then 'warm'
      when has_30d_obs then 'sparse'
      else 'dormant'
    end as recommended_tier
  from per_slug;
$func$;

revoke all on function public.compute_refresh_tier() from public, anon, authenticated;
grant execute on function public.compute_refresh_tier() to service_role;
