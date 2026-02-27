insert into public.canonical_cards (slug, canonical_name, subject, set_name, year, card_number, language, variant)
values
  ('1999_base_set_pikachu_58_102_1st_edition_yellow_cheeks_en', 'Pikachu', 'Pikachu', 'Base Set', 1999, '58/102', 'EN', '1st Edition Yellow Cheeks'),
  ('1999_base_set_pikachu_58_102_unlimited_red_cheeks_en', 'Pikachu', 'Pikachu', 'Base Set', 1999, '58/102', 'EN', 'Unlimited Red Cheeks'),
  ('1999_jungle_pikachu_60_64_en', 'Pikachu', 'Pikachu', 'Jungle', 1999, '60/64', 'EN', null),
  ('2000_fossil_pikachu_70_62_en', 'Pikachu', 'Pikachu', 'Fossil', 2000, '70/62', 'EN', null),
  ('2000_team_rocket_dark_pikachu_70_82_en', 'Dark Pikachu', 'Pikachu', 'Team Rocket', 2000, '70/82', 'EN', null),
  ('2000_gym_challenge_surfing_pikachu_28_132_en', 'Surfing Pikachu', 'Pikachu', 'Gym Challenge', 2000, '28/132', 'EN', null),
  ('2001_neo_genesis_pikachu_70_111_en', 'Pikachu', 'Pikachu', 'Neo Genesis', 2001, '70/111', 'EN', null),
  ('2004_ex_fire_red_leaf_green_pikachu_74_112_en', 'Pikachu', 'Pikachu', 'EX FireRed & LeafGreen', 2004, '74/112', 'EN', null),
  ('2016_xy_evolutions_pikachu_35_108_en', 'Pikachu', 'Pikachu', 'XY Evolutions', 2016, '35/108', 'EN', null),
  ('2017_sm_guardians_rising_pikachu_28_145_en', 'Pikachu', 'Pikachu', 'SM Guardians Rising', 2017, '28/145', 'EN', null),
  ('2019_sun_moon_promo_pikachu_sm234_en', 'Pikachu', 'Pikachu', 'Sun & Moon Promo', 2019, 'SM234', 'EN', 'Cosmic Eclipse'),
  ('2020_sword_shield_vivid_voltage_pikachu_v_043_185_en', 'Pikachu V', 'Pikachu', 'Vivid Voltage', 2020, '043/185', 'EN', null),
  ('2020_sword_shield_vivid_voltage_pikachu_vmax_044_185_en', 'Pikachu VMAX', 'Pikachu', 'Vivid Voltage', 2020, '044/185', 'EN', null),
  ('2021_celebrations_pikachu_005_025_en', 'Pikachu', 'Pikachu', 'Celebrations', 2021, '005/025', 'EN', null),
  ('2022_sword_shield_lost_origin_pikachu_027_196_en', 'Pikachu', 'Pikachu', 'Lost Origin', 2022, '027/196', 'EN', null),
  ('2023_scarlet_violet_151_pikachu_025_165_en', 'Pikachu', 'Pikachu', 'Scarlet & Violet 151', 2023, '025/165', 'EN', null),
  ('2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew', 'Mew ex', 'Mew', 'Pokemon Card 151', 2023, '205/165', 'JP', 'SAR Bubble Mew'),
  ('2023_pokemon_card_151_mew_ex_205_165_en_bubble_mew', 'Mew ex', 'Mew', 'Scarlet & Violet 151', 2023, '205/165', 'EN', 'SAR Bubble Mew'),
  ('1999_base_set_pikachu_58_102_unlimited_yellow_cheeks_en', 'Pikachu', 'Pikachu', 'Base Set', 1999, '58/102', 'EN', 'Unlimited Yellow Cheeks')
on conflict (slug) do nothing;

insert into public.card_aliases (alias, canonical_slug)
values
  ('bubble mew', '2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew'),
  ('mew bubble', '2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew'),
  ('mew ex bubble', '2023_pokemon_card_151_mew_ex_205_165_jp_bubble_mew'),
  ('yellow cheeks pikachu', '1999_base_set_pikachu_58_102_1st_edition_yellow_cheeks_en'),
  ('red cheeks pikachu', '1999_base_set_pikachu_58_102_unlimited_red_cheeks_en'),
  ('surfing pikachu', '2000_gym_challenge_surfing_pikachu_28_132_en')
on conflict (alias, canonical_slug) do nothing;

