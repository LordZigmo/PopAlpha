-- 20260423050000_phase3b_edition_classifier_and_remap.sql
--
-- Phase 3b: edition granularity + shadowless-as-stamp.
--
-- Closes two gaps:
--
-- 1. Plain 'firstedition' / 'unlimited' tokens (~118k rows across 678
--    slugs, mostly vintage WOTC sets) — these had printing_id NULL
--    because the Phase 2 classifier couldn't derive a finish from them.
--    Now: edition is classified from the token and finish is inherited
--    from the slug's canonical preferred row.
--
-- 2. Compound '*shadowlessholofoil' / '*shadowlessholofoil' tokens
--    (~600 rows, Base Set) — these were MIS-ROUTED by Phase 2 to the
--    regular UNLIMITED HOLO printing because `%holo%` matched the
--    finish but the classifier had no stamp dimension. Base Charizard
--    charts were averaging Unlimited (~$tens) with Unlimited
--    Shadowless (~$thousands) as one line.
--
-- Model extensions (no UI change):
--   - Shadowless is a STAMP overlay (SHADOWLESS), not a new edition
--     enum value. Keeps card_printings.edition CHECK stable. Extends
--     the existing stamp vocabulary used by Phase 3a.
--   - New SQL function normalize_scrydex_edition(token) returns
--     FIRST_EDITION / UNLIMITED / NULL.
--   - Trigger resolves on (slug, finish, edition, stamp). Edition
--     defaults to UNLIMITED for tokens that don't specify one. Falls
--     back to any-edition match if no UNLIMITED row exists.
--   - preferred_canonical_raw_printing() already ranks UNLIMITED > all
--     — no change there. 1st Edition rows exist as data but canonical
--     view continues to show UNLIMITED as the headline.
--
-- Rollback: drop normalize_scrydex_edition; revert trigger body to
-- Phase 3a; delete rows where source='phase3b-classifier'.
--
-- Parity: lib/backfill/scrydex-variant-semantics.ts extended in lockstep
-- (SHADOWLESS SpecialVariantSpec; ScrydexNormalizedEdition already
-- handled the firstedition/unlimited distinction).

--------------------------------------------------------------------------
-- Classifier additions
--------------------------------------------------------------------------

create or replace function public.normalize_scrydex_edition(p_token text)
returns text language sql immutable parallel safe as $$
  select case
    when p_token is null or p_token = '' then null
    when lower(p_token) like 'firstedition%' or lower(p_token) like '1stedition%' then 'FIRST_EDITION'
    when lower(p_token) like 'unlimited%' then 'UNLIMITED'
    else null
  end;
$$;

revoke execute on function public.normalize_scrydex_edition(text)
  from public, anon, authenticated;

-- Extend normalize_scrydex_stamp with SHADOWLESS (added at the END so
-- more-specific aliases like 'masterballreverseholofoil' still win).
create or replace function public.normalize_scrydex_stamp(p_token text)
returns text language sql immutable parallel safe as $$
  select case
    when p_token is null or p_token = '' then null
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
    when lower(p_token) like '%cosmos%' then 'COSMOS_HOLO'
    when lower(p_token) like '%crackedice%' then 'CRACKED_ICE_HOLO'
    when lower(p_token) like '%tinselholo%' then 'TINSEL_HOLO'
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
    when lower(p_token) like '%peelabletwo%' or lower(p_token) like '%peelableditto%' then 'PEELABLE_DITTO'
    when lower(p_token) like '%shadowless%' then 'SHADOWLESS'
    else null
  end;
$$;

--------------------------------------------------------------------------
-- Trigger: resolver now includes edition. Default edition=UNLIMITED
-- when the token doesn't specify one (covers the >99% of tokens that
-- don't carry an edition signal and shouldn't be penalized).
--------------------------------------------------------------------------

create or replace function public.price_history_points_derive_printing_columns()
returns trigger language plpgsql as $$
declare
  v_token text;
  v_finish text;
  v_stamp text;
  v_edition text;
  v_base_pid uuid;
  v_resolved_pid uuid;
  v_fallback_edition text;
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
    v_edition := public.normalize_scrydex_edition(v_token);

    if (v_stamp is not null or v_edition is not null) and v_finish = 'UNKNOWN' then
      select cp.finish into v_finish
      from public.card_printings cp
      where cp.id = public.preferred_canonical_raw_printing(new.canonical_slug);
    end if;

    if v_finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO') then
      v_fallback_edition := coalesce(v_edition, 'UNLIMITED');

      select cp.id into v_resolved_pid
      from public.card_printings cp
      where cp.canonical_slug = new.canonical_slug
        and cp.finish = v_finish
        and cp.edition = v_fallback_edition
        and cp.stamp is not distinct from v_stamp
      limit 1;

      -- Fallback: if the token didn't specify an edition and the
      -- UNLIMITED row doesn't exist, accept any edition so Phase 2
      -- behavior (slug-level uniqueness) is preserved.
      if v_resolved_pid is null and v_edition is null then
        select cp.id into v_resolved_pid
        from public.card_printings cp
        where cp.canonical_slug = new.canonical_slug
          and cp.finish = v_finish
          and cp.stamp is not distinct from v_stamp
        limit 1;
      end if;

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
-- Data application: stage edition/shadowless refs, insert missing
-- card_printings rows, remap price_history_points.printing_id.
--------------------------------------------------------------------------

create temporary table if not exists _phase3b_refs (
  canonical_slug text not null,
  variant_ref text not null,
  token text,
  finish text,
  edition text,
  stamp text,
  new_printing_id uuid,
  primary key (canonical_slug, variant_ref)
) on commit drop;

insert into _phase3b_refs (canonical_slug, variant_ref, token)
select canonical_slug, variant_ref,
  substring(variant_ref from '^[0-9a-f-]{36}::[^:]+:([^:]+)::RAW$')
from public.price_history_points
where variant_ref like '%::RAW' and variant_ref not like '%::GRADED::%'
group by canonical_slug, variant_ref
having substring(max(variant_ref) from '^[0-9a-f-]{36}::[^:]+:([^:]+)::RAW$') ~* '(firstedition|unlimited|shadowless)';

update _phase3b_refs
set finish = public.normalize_scrydex_finish(token),
    edition = public.normalize_scrydex_edition(token),
    stamp = public.normalize_scrydex_stamp(token);

update _phase3b_refs r
set finish = (
  select cp.finish from public.card_printings cp
  where cp.id = public.preferred_canonical_raw_printing(r.canonical_slug)
)
where r.finish = 'UNKNOWN' and r.edition is not null;

-- Insert missing card_printings rows for (slug, finish, edition, stamp)
with needs as (
  select distinct canonical_slug, finish, edition, stamp
  from _phase3b_refs
  where finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO')
    and edition is not null
    and not exists (
      select 1 from public.card_printings cp
      where cp.canonical_slug = _phase3b_refs.canonical_slug
        and cp.finish = _phase3b_refs.finish
        and cp.edition = _phase3b_refs.edition
        and cp.stamp is not distinct from _phase3b_refs.stamp
    )
),
src as (
  select distinct on (n.canonical_slug, n.finish, n.edition, n.stamp)
    n.canonical_slug, n.finish, n.edition, n.stamp,
    cp.set_name, cp.set_code, cp.year, cp.card_number, cp.language,
    cp.rarity, cp.image_url
  from needs n
  join public.card_printings cp on cp.canonical_slug = n.canonical_slug
  order by n.canonical_slug, n.finish, n.edition, n.stamp, cp.created_at asc
)
insert into public.card_printings (
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, stamp, rarity, image_url, source, source_id
)
select
  canonical_slug, set_name, set_code, year, card_number, language,
  finish, edition, stamp, rarity, image_url,
  'phase3b-classifier',
  canonical_slug || ':' || finish || ':' || edition || ':' || coalesce(stamp, 'NONE')
from src
on conflict (source, source_id) do nothing;

-- Resolve new_printing_id
update _phase3b_refs r
set new_printing_id = cp.id
from public.card_printings cp
where cp.canonical_slug = r.canonical_slug
  and cp.finish = r.finish
  and cp.edition = r.edition
  and cp.stamp is not distinct from r.stamp
  and r.finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO')
  and r.edition is not null;

-- Remap price_history_points
update public.price_history_points p
set printing_id = r.new_printing_id, finish = r.finish
from _phase3b_refs r
where p.canonical_slug = r.canonical_slug
  and p.variant_ref = r.variant_ref
  and r.new_printing_id is not null
  and p.printing_id is distinct from r.new_printing_id;
