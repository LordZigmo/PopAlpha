insert into public.card_printings (
  id,
  canonical_slug,
  set_name,
  set_code,
  year,
  card_number,
  language,
  finish,
  finish_detail,
  edition,
  stamp,
  rarity,
  image_url,
  source,
  source_id
)
values
  (
    '9d4c1a5f-d33a-4a95-9b8c-82e4ac104111',
    '2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew',
    'Pokemon Card 151',
    'SV2A',
    2023,
    '205/165',
    'JP',
    'ALT_HOLO',
    'SAR Bubble',
    'UNLIMITED',
    null,
    'SAR',
    null,
    'seed',
    'mew_jp_bubble_sar'
  ),
  (
    '44d4dcb6-760d-4b1e-9ec7-f66e4f76a222',
    '1999_base_set_pikachu_58_102_1st_edition_yellow_cheeks_en',
    'Base Set',
    'BS1',
    1999,
    '58/102',
    'EN',
    'NON_HOLO',
    'Yellow Cheeks',
    'FIRST_EDITION',
    null,
    'Common',
    null,
    'seed',
    'pikachu_58_first_yellow'
  ),
  (
    '3b07b008-b9f0-42dc-83fb-5d9fd7607333',
    '1999_base_set_pikachu_58_102_unlimited_yellow_cheeks_en',
    'Base Set',
    'BS1',
    1999,
    '58/102',
    'EN',
    'NON_HOLO',
    'Yellow Cheeks',
    'UNLIMITED',
    null,
    'Common',
    null,
    'seed',
    'pikachu_58_unlimited_yellow'
  ),
  (
    '8e9f2d16-d057-4d0d-b2fb-e9de40f5d444',
    '2016_xy_evolutions_pikachu_35_108_en',
    'XY Evolutions',
    'EVO',
    2016,
    '35/108',
    'EN',
    'HOLO',
    null,
    'UNLIMITED',
    null,
    'Common',
    null,
    'seed',
    'pikachu_evo_holo'
  ),
  (
    'bf7b7776-0fbe-4bca-8d77-d4e25df35555',
    '2016_xy_evolutions_pikachu_35_108_en',
    'XY Evolutions',
    'EVO',
    2016,
    '35/108',
    'EN',
    'REVERSE_HOLO',
    null,
    'UNLIMITED',
    null,
    'Common',
    null,
    'seed',
    'pikachu_evo_reverse'
  )
on conflict do nothing;

insert into public.printing_aliases (alias, printing_id)
values
  ('bubble mew', '9d4c1a5f-d33a-4a95-9b8c-82e4ac104111'),
  ('mew bubble', '9d4c1a5f-d33a-4a95-9b8c-82e4ac104111'),
  ('mew ex bubble', '9d4c1a5f-d33a-4a95-9b8c-82e4ac104111'),
  ('yellow cheeks pikachu', '44d4dcb6-760d-4b1e-9ec7-f66e4f76a222')
on conflict (alias) do update
set printing_id = excluded.printing_id;

