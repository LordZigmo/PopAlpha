-- Add explicit stamp semantics to staged provider observations and
-- backfill variant_ref so legacy 6-part refs carry meaningful edition/stamp data.

alter table public.provider_normalized_observations
  add column if not exists normalized_stamp text not null default 'NONE';

update public.provider_normalized_observations
set normalized_edition = case
  when (
    coalesce(card_name, '') ilike '%1st edition%'
    or coalesce(provider_card_id, '') ilike '%1st-edition%'
    or coalesce(provider_finish, '') ilike '%1st edition%'
  ) then 'FIRST_EDITION'
  else 'UNLIMITED'
end;

update public.provider_normalized_observations
set normalized_stamp = case
  when (
    coalesce(card_name, '') ilike '%pokemon center%'
    or coalesce(provider_card_id, '') ilike '%pokemon-center%'
  ) then 'POKEMON_CENTER'
  else 'NONE'
end;

update public.provider_normalized_observations
set variant_ref =
  split_part(variant_ref, ':', 1)
  || ':'
  || lower(replace(normalized_edition, '_', '-'))
  || ':'
  || case
    when normalized_stamp = 'POKEMON_CENTER' then 'pokemon-center'
    else 'none'
  end
  || ':'
  || split_part(variant_ref, ':', 4)
  || ':'
  || split_part(variant_ref, ':', 5)
  || ':'
  || split_part(variant_ref, ':', 6)
where variant_ref like '%:%:%:%:%:%';
