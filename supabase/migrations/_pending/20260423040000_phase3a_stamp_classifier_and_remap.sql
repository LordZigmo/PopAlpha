-- 20260423040000_phase3a_stamp_classifier_and_remap.sql
--
-- Phase 3a: stamp / finish-pattern granularity.
--
-- Kills the remaining ~5% Phase-2 residue where multiple Scrydex
-- provider_variant tokens share one finish bucket (HOLO or REVERSE_HOLO)
-- but represent distinct physical printings — cosmosholofoil vs
-- playpokemonstampholofoil vs regular holofoil, masterball vs pokeball
-- reverse-holo patterns, league/staff/holiday stamps, etc.
--
-- Mirrors the mechanism from Phase 2 but extends the bucketing tuple
-- from (slug, finish) to (slug, finish, stamp):
--   - Classifier emits a stamp value alongside finish.
--   - Card_printings rows inserted for every (slug, finish, stamp) that
--     has provider-history rows and isn't already modeled.
--   - price_history_points.printing_id remapped to the stamped row.
--   - BEFORE INSERT trigger looks up (slug, finish, stamp).
--
-- Rollback: drop function normalize_scrydex_stamp, revert trigger body
-- to Phase 2f, delete rows where source = 'phase3a-classifier', and
-- remap affected price_history_points back to their stamp=NULL target
-- (lossy — remap forwards is clean, backwards requires re-deriving).
--
-- Parity: lib/backfill/scrydex-variant-semantics.ts mirrors this
-- vocabulary. Update both in lockstep.

--------------------------------------------------------------------------
-- Classifier: token -> stamp value.
-- Order is significant: most specific aliases first so a compound token
-- like 'masterballreverseholofoil' resolves to MASTER_BALL_PATTERN
-- before falling through to a generic 'reverse' branch.
--------------------------------------------------------------------------

create or replace function public.normalize_scrydex_stamp(p_token text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_token is null or p_token = '' then null

    -- Ball-pattern reverse holos
    when lower(p_token) like '%masterball%' then 'MASTER_BALL_PATTERN'
    when lower(p_token) like '%pokeball%' then 'POKE_BALL_PATTERN'
    when lower(p_token) like '%duskball%' then 'DUSK_BALL_PATTERN'
    when lower(p_token) like '%quickball%' then 'QUICK_BALL_PATTERN'
    when lower(p_token) like '%greatball%' then 'GREAT_BALL_PATTERN'
    when lower(p_token) like '%ultraball%' then 'ULTRA_BALL_PATTERN'
    when lower(p_token) like '%friendball%' then 'FRIEND_BALL_PATTERN'
    when lower(p_token) like '%loveball%' then 'LOVE_BALL_PATTERN'
    when lower(p_token) like '%heavyball%' then 'HEAVY_BALL_PATTERN'
    when lower(p_token) like '%levelball%' then 'LEVEL_BALL_PATTERN'
    when lower(p_token) like '%dreamball%' then 'DREAM_BALL_PATTERN'
    when lower(p_token) like '%premierball%' then 'PREMIER_BALL_PATTERN'
    when lower(p_token) like '%dualball%' then 'DUAL_BALL_PATTERN'
    when lower(p_token) like '%nestball%' then 'NEST_BALL_PATTERN'
    when lower(p_token) like '%beastball%' then 'BEAST_BALL_PATTERN'
    when lower(p_token) like '%cherishball%' then 'CHERISH_BALL_PATTERN'
    when lower(p_token) like '%luxuryball%' then 'LUXURY_BALL_PATTERN'
    when lower(p_token) like '%lureball%' then 'LURE_BALL_PATTERN'
    when lower(p_token) like '%magmaball%' then 'MAGMA_BALL_PATTERN'
    when lower(p_token) like '%aquaball%' then 'AQUA_BALL_PATTERN'
    when lower(p_token) like '%lightball%' then 'LIGHT_BALL_PATTERN'
    when lower(p_token) like '%energyreverse%' or lower(p_token) like '%energysymbol%' then 'ENERGY_SYMBOL_PATTERN'
    when lower(p_token) like '%rocketreverse%' or lower(p_token) like '%teamrocket%' then 'TEAM_ROCKET'

    -- Holo patterns
    when lower(p_token) like '%cosmos%' then 'COSMOS_HOLO'
    when lower(p_token) like '%crackedice%' then 'CRACKED_ICE_HOLO'
    when lower(p_token) like '%tinselholo%' then 'TINSEL_HOLO'

    -- Stamps (league-place checks precede plain leaguestamp)
    when lower(p_token) like 'league1stplace%' then 'LEAGUE_1ST_PLACE'
    when lower(p_token) like 'league2ndplace%' then 'LEAGUE_2ND_PLACE'
    when lower(p_token) like 'league3rdplace%' then 'LEAGUE_3RD_PLACE'
    when lower(p_token) like 'league4thplace%' then 'LEAGUE_4TH_PLACE'
    when lower(p_token) like 'leaguestamp%' then 'LEAGUE_STAMP'
    when lower(p_token) like '%pokemoncenter%' then 'POKEMON_CENTER'
    when lower(p_token) like '%playpokemonstamp%' then 'PLAY_POKEMON_STAMP'
    when lower(p_token) like 'staffstamp%' or lower(p_token) = 'staff' then 'STAFF_STAMP'
    when lower(p_token) like 'holidaystamp%' then 'HOLIDAY_STAMP'
    when lower(p_token) like 'expansionstamp%' then 'EXPANSION_STAMP'
    when lower(p_token) like 'burgerking%' then 'BURGER_KING_STAMP'
    when lower(p_token) like 'prerelease%' then 'PRERELEASE'
    when lower(p_token) = 'wstamp' then 'W_STAMP'

    -- Special cards
    when lower(p_token) like '%peelabletwo%' or lower(p_token) like '%peelableditto%' then 'PEELABLE_DITTO'

    else null
  end;
$$;

revoke execute on function public.normalize_scrydex_stamp(text)
  from public, anon, authenticated;

--------------------------------------------------------------------------
-- Trigger: resolver now keys on (slug, finish, stamp).
--
-- Two notable behaviors:
--   1. When a token carries a known stamp but no finish signal (e.g.
--      'leaguestamp' — just a stamp, no holo/foil), inherit finish from
--      the slug's canonical preferred row.
--   2. When stamp is null (no stamp token), the IS NOT DISTINCT FROM
--      check resolves to a card_printings row with stamp IS NULL.
--------------------------------------------------------------------------

create or replace function public.price_history_points_derive_printing_columns()
returns trigger
language plpgsql
as $$
declare
  v_token text;
  v_finish text;
  v_stamp text;
  v_base_pid uuid;
  v_resolved_pid uuid;
begin
  if new.printing_id is not null and new.finish is not null then
    return new;
  end if;
  if new.variant_ref is null
     or new.variant_ref not like '%::RAW'
     or new.variant_ref like '%::GRADED::%' then
    return new;
  end if;

  v_base_pid := public.variant_ref_base_printing_id(new.variant_ref);
  v_token := public.variant_ref_provider_token(new.variant_ref);

  if v_token is not null then
    v_finish := public.normalize_scrydex_finish(v_token);
    v_stamp := public.normalize_scrydex_stamp(v_token);

    if v_stamp is not null and v_finish = 'UNKNOWN' then
      select cp.finish into v_finish
      from public.card_printings cp
      where cp.id = public.preferred_canonical_raw_printing(new.canonical_slug);
    end if;

    if v_finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO') then
      select cp.id into v_resolved_pid
      from public.card_printings cp
      where cp.canonical_slug = new.canonical_slug
        and cp.finish = v_finish
        and cp.stamp is not distinct from v_stamp
      limit 1;
      if v_resolved_pid is not null then
        new.printing_id := coalesce(new.printing_id, v_resolved_pid);
        new.finish := coalesce(new.finish, v_finish);
      end if;
    end if;
    new.provider_variant_token := coalesce(new.provider_variant_token, v_token);
  elsif v_base_pid is not null then
    select cp.finish into v_finish
    from public.card_printings cp
    where cp.id = v_base_pid limit 1;
    if v_finish is not null then
      new.printing_id := coalesce(new.printing_id, v_base_pid);
      new.finish := coalesce(new.finish, v_finish);
    end if;
  end if;

  return new;
end $$;

--------------------------------------------------------------------------
-- Data application steps:
--   1. Insert missing (slug, finish, stamp) rows.
--   2. Remap price_history_points.printing_id to the stamped row.
-- Both are idempotent (ON CONFLICT DO NOTHING / WHERE printing_id IS
-- DISTINCT FROM target). Uses a temp table to stage classified refs
-- efficiently.
--------------------------------------------------------------------------

create temporary table if not exists _phase3a_refs (
  canonical_slug text not null,
  variant_ref text not null,
  token text,
  finish text,
  stamp text,
  primary key (canonical_slug, variant_ref)
) on commit drop;

insert into _phase3a_refs (canonical_slug, variant_ref, token)
select canonical_slug, variant_ref,
  substring(variant_ref from '^[0-9a-f-]{36}::[^:]+:([^:]+)::RAW$')
from public.price_history_points
where provider in ('SCRYDEX','POKEMON_TCG_API')
  and source_window = 'snapshot'
  and variant_ref like '%::RAW'
  and variant_ref not like '%::GRADED::%'
group by canonical_slug, variant_ref;

update _phase3a_refs
set finish = public.normalize_scrydex_finish(token),
    stamp = public.normalize_scrydex_stamp(token);

-- Inherit finish from slug's canonical row when the token only carries a
-- stamp signal (leaguestamp, staffstamp, etc.).
update _phase3a_refs r
set finish = (
  select cp.finish from public.card_printings cp
  where cp.id = public.preferred_canonical_raw_printing(r.canonical_slug)
)
where r.finish = 'UNKNOWN' and r.stamp is not null;

-- Insert missing card_printings rows.
with src as (
  select distinct on (r.canonical_slug, r.finish, r.stamp)
    r.canonical_slug, r.finish, r.stamp,
    cp.set_name, cp.set_code, cp.year, cp.card_number, cp.language,
    cp.edition, cp.rarity, cp.image_url
  from _phase3a_refs r
  join public.card_printings cp on cp.canonical_slug = r.canonical_slug
  where r.stamp is not null
    and r.finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO')
    and not exists (
      select 1 from public.card_printings cp2
      where cp2.canonical_slug = r.canonical_slug
        and cp2.finish = r.finish
        and cp2.stamp is not distinct from r.stamp
    )
  order by r.canonical_slug, r.finish, r.stamp, cp.created_at asc
)
insert into public.card_printings (
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, stamp, rarity, image_url, source, source_id
)
select
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, stamp, rarity, image_url,
  'phase3a-classifier',
  canonical_slug || ':' || finish || ':' || stamp
from src
on conflict (source, source_id) do nothing;

-- Remap history rows whose current printing_id doesn't match the stamped
-- target. Join via the staged refs + matched card_printings; process in
-- one go since the refs table is small (~37k rows).
update public.price_history_points p
set printing_id = cp.id, finish = r.finish
from _phase3a_refs r
join public.card_printings cp
  on cp.canonical_slug = r.canonical_slug
 and cp.finish = r.finish
 and cp.stamp is not distinct from r.stamp
where p.canonical_slug = r.canonical_slug
  and p.variant_ref = r.variant_ref
  and r.stamp is not null
  and r.finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO')
  and p.printing_id is distinct from cp.id;
