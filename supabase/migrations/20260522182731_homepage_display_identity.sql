-- Public, read-only identity hints for homepage card tiles.
--
-- The underlying provider mapping tables stay internal-only, but the app
-- needs two safe display fields on public surfaces:
--   1. full collector number when a matched provider exposes it (003/017)
--   2. the preferred RAW printing identity behind canonical headline prices
--
-- This mirrors the existing public_card_metrics pattern: expose a curated
-- subset instead of granting direct provider_card_map access.

create or replace view public.public_card_display_identity as
with provider_numbers as (
  select
    pcm.canonical_slug,
    btrim(pcm.metadata->>'provider_card_number') as provider_card_number,
    pcm.provider,
    pcm.updated_at
  from public.provider_card_map pcm
  join public.canonical_cards cc
    on cc.slug = pcm.canonical_slug
  where pcm.mapping_status = 'MATCHED'
    and pcm.canonical_slug is not null
    and pcm.asset_type = 'single'
    and btrim(coalesce(pcm.metadata->>'provider_card_number', '')) ~ '^[0-9A-Za-z]+/[0-9A-Za-z]+$'
    and lower(regexp_replace(split_part(btrim(pcm.metadata->>'provider_card_number'), '/', 1), '^0+', ''))
      = lower(regexp_replace(coalesce(cc.card_number, ''), '^0+', ''))
),
ranked_provider_numbers as (
  select
    provider_numbers.*,
    row_number() over (
      partition by provider_numbers.canonical_slug
      order by
        case provider_numbers.provider
          when 'JUSTTCG' then 0
          when 'POKEMON_TCG_API' then 1
          when 'SCRYDEX' then 2
          else 9
        end,
        provider_numbers.updated_at desc,
        provider_numbers.provider_card_number
    ) as rn
  from provider_numbers
),
printing_counts as (
  select
    cp.canonical_slug,
    count(*)::integer as printing_count,
    count(distinct coalesce(cp.finish, 'UNKNOWN'))::integer as finish_count
  from public.card_printings cp
  group by cp.canonical_slug
),
preferred_printings as (
  select
    cc.slug,
    cp.id as price_printing_id,
    cp.finish as price_finish,
    cp.edition as price_edition,
    cp.stamp as price_stamp
  from public.canonical_cards cc
  left join public.card_printings cp
    on cp.id = public.preferred_canonical_raw_printing(cc.slug)
)
select
  cc.slug,
  coalesce(rpn.provider_card_number, cc.card_number) as display_card_number,
  rpn.provider_card_number,
  cc.card_number as canonical_card_number,
  pp.price_printing_id,
  pp.price_finish,
  pp.price_edition,
  pp.price_stamp,
  coalesce(pc.printing_count, 0) as printing_count,
  coalesce(pc.finish_count, 0) as finish_count,
  coalesce(pc.printing_count, 0) > 1 as has_multiple_printings,
  coalesce(pc.finish_count, 0) > 1 as has_multiple_finishes
from public.canonical_cards cc
left join ranked_provider_numbers rpn
  on rpn.canonical_slug = cc.slug
 and rpn.rn = 1
left join printing_counts pc
  on pc.canonical_slug = cc.slug
left join preferred_printings pp
  on pp.slug = cc.slug;

grant select on public.public_card_display_identity to anon, authenticated;

comment on view public.public_card_display_identity is
  'Safe public display metadata for homepage/search tiles: full collector numbers and preferred RAW printing identity. Does not expose provider IDs, provider raw payloads, or pricing observations.';
