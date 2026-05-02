-- 20260423000000_phase2b_missing_finish_printings.sql
--
-- Phase 2b: ensure every (canonical_slug, finish) that has classifier-
-- derivable Scrydex provider-history rows is represented by a row in
-- card_printings. Depends on Phase 2a (classifier functions).
--
-- Strategy (two passes, applied idempotently — re-runs are no-ops):
--
--   Pass A. For slugs whose ONLY existing card_printings row has
--     finish='UNKNOWN' (seed data from pokemon-tcg-data couldn't determine
--     finish), UPDATE that row's finish to the primary derived finish
--     following priority NON_HOLO > HOLO > REVERSE_HOLO. This preserves
--     the existing printing_id so canonical '<id>::RAW' variant_refs keep
--     resolving. The source / source_id are intentionally left alone —
--     source_id reflects provider identity, not our derived finish.
--
--   Pass B. For (slug, finish) gaps that remain after Pass A, INSERT new
--     card_printings rows. Metadata (set_name, set_code, card_number,
--     language, edition, rarity, image_url) is copied from the slug's
--     earliest existing card_printings row. The new rows carry
--     source='phase2b-classifier' and source_id = slug||':'||finish,
--     which is unique by construction (the (source, source_id) unique
--     from 20260420140000 guards idempotency for re-runs).
--
-- Scope (per 2026-04-23 user decision — "Option A"):
--   Only maps classifier-derived NON_HOLO / HOLO / REVERSE_HOLO gaps.
--   The remaining UNKNOWN-classifier slugs (stamps, editions, jumbos,
--   artist promos — ~1,879 slugs) are explicitly deferred to Phase 3,
--   which will extend the model to cover stamp / edition / special
--   dimensions rather than forcing them into a single 'finish' column.
--
-- Expected impact (from staged dry-run ran pre-apply 2026-04-22):
--   Pass A: ~3,913 UNKNOWN rows upgraded.
--   Pass B: ~6,076 new rows inserted (5,282 REVERSE_HOLO, 444 NON_HOLO,
--           350 HOLO).
--
-- Rollback: delete rows where source='phase2b-classifier'; Pass A
-- upgrades are not trivially reversed (source_id still says 'UNKNOWN'),
-- but the forward direction is clear and card_printings queries care
-- about current finish, not historical finish.

--------------------------------------------------------------------------
-- Temporary staging: distinct (slug, variant_ref) with provider-history
-- tokens, classified into NON_HOLO / HOLO / REVERSE_HOLO. Restricting to
-- source_window='snapshot' keeps the scan small (~37k rows).
--------------------------------------------------------------------------

create temporary table if not exists _phase2b_gaps (
  canonical_slug text not null,
  finish text not null,
  token text,
  primary key (canonical_slug, finish)
) on commit drop;

-- Using inline regex substring (instead of the public.variant_ref_provider_token
-- function) because the function call is not inlined by the planner in this
-- shape, causing statement timeouts on the 13M-row base table scan. Inline
-- regex evaluates as a fast scan predicate. Output is equivalent.
insert into _phase2b_gaps (canonical_slug, finish, token)
select
  r.canonical_slug,
  case
    when lower(r.token) like '%reverse%' then 'REVERSE_HOLO'
    when lower(r.token) = 'normal' then 'NON_HOLO'
    when lower(r.token) like '%nonholo%' then 'NON_HOLO'
    when lower(r.token) like '%holo%' then 'HOLO'
    when lower(r.token) like '%foil%' then 'HOLO'
    else 'UNKNOWN'
  end as finish,
  r.token
from (
  select distinct
    canonical_slug,
    substring(variant_ref from '^[0-9a-f-]{36}::[^:]+:([^:]+)::RAW$') as token
  from public.price_history_points
  where provider in ('SCRYDEX','POKEMON_TCG_API')
    and source_window = 'snapshot'
    and variant_ref like '%::RAW'
    and variant_ref not like '%::GRADED::%'
) r
where r.token is not null
on conflict (canonical_slug, finish) do nothing;

delete from _phase2b_gaps g
where g.finish not in ('NON_HOLO','HOLO','REVERSE_HOLO')
   or exists (
     select 1 from public.card_printings cp
     where cp.canonical_slug = g.canonical_slug
       and cp.finish = g.finish
   );

--------------------------------------------------------------------------
-- Pass A: upgrade 'finish=UNKNOWN' rows in place.
--------------------------------------------------------------------------

with primary_derived as (
  select
    g.canonical_slug,
    (array_agg(g.finish order by
      case g.finish
        when 'NON_HOLO' then 1
        when 'HOLO' then 2
        when 'REVERSE_HOLO' then 3
        else 9
      end
    ))[1] as primary_finish
  from _phase2b_gaps g
  where exists (
    select 1 from public.card_printings cp
    where cp.canonical_slug = g.canonical_slug and cp.finish = 'UNKNOWN'
  )
  and not exists (
    select 1 from public.card_printings cp
    where cp.canonical_slug = g.canonical_slug and cp.finish <> 'UNKNOWN'
  )
  group by g.canonical_slug
)
update public.card_printings cp
set finish = p.primary_finish
from primary_derived p
where cp.canonical_slug = p.canonical_slug
  and cp.finish = 'UNKNOWN';

-- Remove gaps that Pass A resolved so Pass B doesn't re-touch them.
delete from _phase2b_gaps g
where exists (
  select 1 from public.card_printings cp
  where cp.canonical_slug = g.canonical_slug and cp.finish = g.finish
);

--------------------------------------------------------------------------
-- Pass B: insert new card_printings rows for remaining gaps. Metadata
-- copied from the slug's earliest existing row. ON CONFLICT (source,
-- source_id) DO NOTHING makes re-runs idempotent.
--------------------------------------------------------------------------

with src as (
  select distinct on (g.canonical_slug, g.finish)
    g.canonical_slug, g.finish,
    cp.set_name, cp.set_code, cp.year, cp.card_number, cp.language,
    cp.edition, cp.rarity, cp.image_url
  from _phase2b_gaps g
  join public.card_printings cp on cp.canonical_slug = g.canonical_slug
  order by g.canonical_slug, g.finish, cp.created_at asc
)
insert into public.card_printings (
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, rarity, image_url, source, source_id
)
select
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, rarity, image_url,
  'phase2b-classifier' as source,
  canonical_slug || ':' || finish as source_id
from src
on conflict (source, source_id) do nothing;
