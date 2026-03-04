-- Add explicit edition semantics to staged provider observations.
-- For Pokemon singles, default non-1st-edition rows to UNLIMITED instead of UNKNOWN.

alter table public.provider_normalized_observations
  add column if not exists normalized_edition text not null default 'UNKNOWN';

update public.provider_normalized_observations
set normalized_edition = case
  when asset_type = 'single' then 'UNLIMITED'
  else 'UNKNOWN'
end
where normalized_edition = 'UNKNOWN';

update public.provider_normalized_observations
set variant_ref =
  split_part(variant_ref, ':', 1)
  || ':'
  || lower(replace(normalized_edition, '_', '-'))
  || ':'
  || split_part(variant_ref, ':', 3)
  || ':'
  || split_part(variant_ref, ':', 4)
  || ':'
  || split_part(variant_ref, ':', 5)
  || ':'
  || split_part(variant_ref, ':', 6)
where variant_ref like '%:%:%:%:%:%';
