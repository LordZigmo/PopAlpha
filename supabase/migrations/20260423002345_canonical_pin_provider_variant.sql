-- 20260422200000_canonical_pin_provider_variant.sql
--
-- Phase 1 fix for the iOS chart / web market summary "zig-zag" that still
-- occurs on cards where one card_printings row hosts multiple Scrydex
-- provider_variant suffixes (e.g. ':normal' + ':reverseholofoil' under a
-- single printing_id). Reported 2026-04-22 for 'crown-zenith-109-snorlax'
-- bouncing between <$1 (normal) and ~$8 (reverse holo) as one series.
--
-- Why the April 15 fix wasn't enough:
--   preferred_canonical_raw_printing(slug) returns only a printing_id, and
--   the view pins 'variant_ref like printing_id::%' — which still matches
--   every finish cohort under that printing_id. For ~8,180 of ~19,659
--   canonical slugs with RAW history (41%), more than one provider_variant
--   cohort lives under one printing_id.
--
-- Phase 1 fix (this migration):
--   Pin on the FULL dominant variant_ref, not just the printing_id. The
--   picker prefers ':normal' > ':holofoil' > ':reverseholofoil' > other,
--   tiebreaking by snapshot count and lexical order. This embeds the
--   Scrydex finish naming convention deliberately so the "headline" RAW
--   series is always the base print when one exists.
--
-- Phase 2 (follow-up, not in this migration):
--   Split reverse-holo (and holo-vs-non-holo where collapsed) into their
--   own card_printings rows so iOS can surface them as real finish pills.
--   Once that lands, this picker becomes a safety net for stragglers.

create or replace function public.preferred_canonical_raw_variant_ref(p_slug text)
returns text
language sql
stable
set search_path = public
as $$
  select variant_ref
  from (
    select
      ph.variant_ref,
      count(*) as snap_points,
      max(ph.ts) as latest_ts,
      case
        when ph.variant_ref ~ ':normal::RAW$' then 1
        when ph.variant_ref ~ ':holofoil::RAW$' then 2
        when ph.variant_ref ~ ':reverseholofoil::RAW$' then 3
        else 4
      end as finish_rank
    from public.price_history_points ph
    where ph.canonical_slug = p_slug
      and ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      -- Match the outer view's source_window scope so a slug with only
      -- '30d' rows (backfilled, no snapshot yet) doesn't silently return
      -- an empty series.
      and ph.source_window in ('snapshot', '30d')
      and ph.variant_ref like '%::RAW'
      and ph.variant_ref not like '%::GRADED::%'
      and ph.ts > now() - interval '60 days'
    group by ph.variant_ref
  ) c
  order by c.finish_rank asc, c.snap_points desc, c.latest_ts desc, c.variant_ref asc
  limit 1;
$$;

-- Keep consistent with the allowlist pattern established in
-- 20260318104000_public_function_execute_allowlist.sql: the view runs as
-- postgres so public callers never need direct execute.
revoke execute on function public.preferred_canonical_raw_variant_ref(text)
  from public, anon, authenticated;

create or replace view public.public_price_history_canonical as
select
  ph.id,
  ph.canonical_slug,
  ph.variant_ref,
  ph.provider,
  ph.ts,
  ph.price,
  ph.currency,
  ph.source_window,
  ph.created_at
from public.price_history_points ph
where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
  and ph.source_window in ('snapshot', '30d')
  -- Cheap index-compatible predicates first: most rows are eliminated
  -- before the per-slug function call is considered. The equality check
  -- below already enforces these implicitly via the picker's own filters,
  -- but keeping them here halves the planner's per-row work on hot paths
  -- like app/api/portfolio/overview (.in('canonical_slug', slugs)).
  and ph.variant_ref like '%::RAW'
  and ph.variant_ref not like '%::GRADED::%'
  and ph.variant_ref = coalesce(
    public.preferred_canonical_raw_variant_ref(ph.canonical_slug),
    '!!NONE!!'
  );

grant select on public.public_price_history_canonical to anon, authenticated;
