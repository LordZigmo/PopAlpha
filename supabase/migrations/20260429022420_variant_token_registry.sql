-- 20260428040000_variant_token_registry.sql
--
-- Self-healing variant token registry.
--
-- Replaces the hardcoded SPECIAL_VARIANT_SPECS array in
-- lib/backfill/scrydex-variant-semantics.ts as the source of truth for
-- (provider, raw_token) -> (normalized_stamp, normalized_finish, display_label).
--
-- When the normalize pipeline encounters a token it doesn't recognize
-- (e.g. a brand-new "comicconstamp" Scrydex variant), it inserts a row
-- here with status='auto' and a humanized display_label. Admins can
-- review status='auto' rows in /internal/admin/variant-tokens, edit
-- the display_label, and flip status to 'approved' or 'hidden'.
--
-- Display surfaces (card detail pills, charts) read display_label from
-- this table instead of title-casing the stamp enum, so a freshly
-- auto-registered "comicconstamp" appears as "Comic Con" everywhere
-- without a code change.
--
-- Mirrors the vocabulary in scrydex-variant-semantics.ts and the
-- public.normalize_scrydex_stamp() function from migration
-- 20260423040000. The TS code keeps a small fallback dictionary for
-- safety but the registry is the operational source of truth.
--
-- Rollback: drop table variant_token_registry; drop function
-- public.variant_token_display_label.

------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------

create table if not exists public.variant_token_registry (
  provider text not null,
  raw_token text not null,
  normalized_stamp text not null default 'NONE',
  normalized_finish text not null default 'UNKNOWN',
  forced_finish text,
  display_label text not null,
  status text not null default 'auto',
  source text not null default 'auto-register',
  observation_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sample_canonical_slug text,
  sample_observed_price numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (provider, raw_token),
  constraint variant_token_registry_status_check
    check (status in ('auto', 'approved', 'hidden')),
  constraint variant_token_registry_source_check
    check (source in ('seed', 'auto-register', 'manual')),
  constraint variant_token_registry_finish_check
    check (normalized_finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO', 'UNKNOWN')),
  constraint variant_token_registry_forced_finish_check
    check (forced_finish is null
           or forced_finish in ('NON_HOLO', 'HOLO', 'REVERSE_HOLO'))
);

create index if not exists variant_token_registry_status_count_idx
  on public.variant_token_registry (status, observation_count desc);

create index if not exists variant_token_registry_stamp_status_idx
  on public.variant_token_registry (normalized_stamp, status, observation_count desc);

create index if not exists variant_token_registry_last_seen_idx
  on public.variant_token_registry (last_seen_at desc);

------------------------------------------------------------------------
-- updated_at trigger
------------------------------------------------------------------------

create or replace function public.variant_token_registry_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists variant_token_registry_touch
  on public.variant_token_registry;
create trigger variant_token_registry_touch
  before update on public.variant_token_registry
  for each row
  execute function public.variant_token_registry_touch_updated_at();

------------------------------------------------------------------------
-- Display-label lookup helper.
------------------------------------------------------------------------

create or replace function public.variant_token_display_label(p_stamp text)
returns text
language sql
stable
parallel safe
as $$
  select display_label
    from public.variant_token_registry
   where normalized_stamp = p_stamp
     and status in ('approved', 'auto')
   order by case status when 'approved' then 0 else 1 end,
            observation_count desc
   limit 1
$$;

revoke execute on function public.variant_token_display_label(text)
  from public, anon, authenticated;

------------------------------------------------------------------------
-- Touch helper.
------------------------------------------------------------------------

create or replace function public.variant_token_registry_touch_row(
  p_provider text,
  p_raw_token text,
  p_sample_slug text,
  p_sample_price numeric
)
returns void
language sql
as $$
  update public.variant_token_registry
     set last_seen_at = now(),
         observation_count = observation_count + 1,
         sample_canonical_slug = coalesce(sample_canonical_slug, p_sample_slug),
         sample_observed_price = coalesce(sample_observed_price, p_sample_price)
   where provider = p_provider
     and raw_token = p_raw_token;
$$;

revoke execute on function public.variant_token_registry_touch_row(text, text, text, numeric)
  from public, anon, authenticated;

------------------------------------------------------------------------
-- Public-readable view: stamp -> display_label only.
------------------------------------------------------------------------

create or replace view public.public_stamp_display_labels as
select distinct on (normalized_stamp)
  normalized_stamp,
  display_label
from public.variant_token_registry
where status in ('approved', 'auto')
  and normalized_stamp <> 'NONE'
order by normalized_stamp,
         case status when 'approved' then 0 else 1 end,
         observation_count desc;

grant select on public.public_stamp_display_labels to anon, authenticated;

------------------------------------------------------------------------
-- RLS — service-role only.
------------------------------------------------------------------------

alter table public.variant_token_registry enable row level security;

drop policy if exists variant_token_registry_no_anon on public.variant_token_registry;
create policy variant_token_registry_no_anon
  on public.variant_token_registry
  as restrictive
  to anon, authenticated
  using (false)
  with check (false);

------------------------------------------------------------------------
-- Seed: mirror SPECIAL_VARIANT_SPECS as status='approved'.
------------------------------------------------------------------------

insert into public.variant_token_registry
  (provider, raw_token, normalized_stamp, normalized_finish, forced_finish, display_label, status, source, observation_count)
values
  ('SCRYDEX', 'pokemoncenterstamp', 'POKEMON_CENTER', 'UNKNOWN', null, 'Pokemon Center', 'approved', 'seed', 0),
  ('SCRYDEX', 'pokemoncenter',      'POKEMON_CENTER', 'UNKNOWN', null, 'Pokemon Center', 'approved', 'seed', 0),

  ('SCRYDEX', 'masterballreverseholofoil', 'MASTER_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Master Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'masterballreverseholo',     'MASTER_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Master Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'masterball',                'MASTER_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Master Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'pokeballreverseholofoil',   'POKE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Poke Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'pokeballreverseholo',       'POKE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Poke Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'pokeball',                  'POKE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Poke Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'duskballreverseholofoil',   'DUSK_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Dusk Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'duskballreverseholo',       'DUSK_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Dusk Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'duskball',                  'DUSK_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Dusk Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'quickballreverseholofoil',  'QUICK_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Quick Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'quickballreverseholo',      'QUICK_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Quick Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'quickball',                 'QUICK_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Quick Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'greatballreverseholofoil',  'GREAT_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Great Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'greatballreverseholo',      'GREAT_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Great Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'greatball',                 'GREAT_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Great Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'ultraballreverseholofoil',  'ULTRA_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Ultra Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'ultraballreverseholo',      'ULTRA_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Ultra Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'ultraball',                 'ULTRA_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Ultra Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'friendballreverseholofoil', 'FRIEND_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Friend Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'friendballreverseholo',     'FRIEND_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Friend Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'friendball',                'FRIEND_BALL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Friend Ball', 'approved', 'seed', 0),
  ('SCRYDEX', 'loveballreverseholofoil',   'LOVE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Love Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'loveballreverseholo',       'LOVE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Love Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'loveball',                  'LOVE_BALL_PATTERN',   'REVERSE_HOLO', 'REVERSE_HOLO', 'Love Ball',   'approved', 'seed', 0),
  ('SCRYDEX', 'heavyballreverseholofoil',  'HEAVY_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Heavy Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'heavyballreverseholo',      'HEAVY_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Heavy Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'heavyball',                 'HEAVY_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Heavy Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'levelballreverseholofoil',  'LEVEL_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Level Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'levelballreverseholo',      'LEVEL_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Level Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'levelball',                 'LEVEL_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Level Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'dreamballreverseholofoil',  'DREAM_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Dream Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'dreamballreverseholo',      'DREAM_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Dream Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'dreamball',                 'DREAM_BALL_PATTERN',  'REVERSE_HOLO', 'REVERSE_HOLO', 'Dream Ball',  'approved', 'seed', 0),
  ('SCRYDEX', 'premierballreverseholofoil','PREMIER_BALL_PATTERN','REVERSE_HOLO', 'REVERSE_HOLO', 'Premier Ball','approved', 'seed', 0),
  ('SCRYDEX', 'premierballreverseholo',    'PREMIER_BALL_PATTERN','REVERSE_HOLO', 'REVERSE_HOLO', 'Premier Ball','approved', 'seed', 0),
  ('SCRYDEX', 'premierball',               'PREMIER_BALL_PATTERN','REVERSE_HOLO', 'REVERSE_HOLO', 'Premier Ball','approved', 'seed', 0),

  ('SCRYDEX', 'energyreverseholofoil', 'ENERGY_SYMBOL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Energy Symbol', 'approved', 'seed', 0),
  ('SCRYDEX', 'energyreverseholo',     'ENERGY_SYMBOL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Energy Symbol', 'approved', 'seed', 0),
  ('SCRYDEX', 'energysymbolpattern',   'ENERGY_SYMBOL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Energy Symbol', 'approved', 'seed', 0),
  ('SCRYDEX', 'energysymbol',          'ENERGY_SYMBOL_PATTERN', 'REVERSE_HOLO', 'REVERSE_HOLO', 'Energy Symbol', 'approved', 'seed', 0),
  ('SCRYDEX', 'rocketreverseholofoil', 'TEAM_ROCKET',           'REVERSE_HOLO', 'REVERSE_HOLO', 'Team Rocket',   'approved', 'seed', 0),
  ('SCRYDEX', 'rocketreverseholo',     'TEAM_ROCKET',           'REVERSE_HOLO', 'REVERSE_HOLO', 'Team Rocket',   'approved', 'seed', 0),
  ('SCRYDEX', 'teamrocket',            'TEAM_ROCKET',           'REVERSE_HOLO', 'REVERSE_HOLO', 'Team Rocket',   'approved', 'seed', 0),
  ('SCRYDEX', 'rocket',                'TEAM_ROCKET',           'REVERSE_HOLO', 'REVERSE_HOLO', 'Team Rocket',   'approved', 'seed', 0),

  ('SCRYDEX', 'cosmosholofoil',     'COSMOS_HOLO',      'HOLO', 'HOLO', 'Cosmos',      'approved', 'seed', 0),
  ('SCRYDEX', 'cosmos',             'COSMOS_HOLO',      'HOLO', 'HOLO', 'Cosmos',      'approved', 'seed', 0),
  ('SCRYDEX', 'crackediceholofoil', 'CRACKED_ICE_HOLO', 'HOLO', 'HOLO', 'Cracked Ice', 'approved', 'seed', 0),
  ('SCRYDEX', 'crackedice',         'CRACKED_ICE_HOLO', 'HOLO', 'HOLO', 'Cracked Ice', 'approved', 'seed', 0),
  ('SCRYDEX', 'tinselholofoil',     'TINSEL_HOLO',      'HOLO', 'HOLO', 'Tinsel',      'approved', 'seed', 0),
  ('SCRYDEX', 'tinselholo',         'TINSEL_HOLO',      'HOLO', 'HOLO', 'Tinsel',      'approved', 'seed', 0),

  ('SCRYDEX', 'playpokemonstampholofoil', 'PLAY_POKEMON_STAMP', 'UNKNOWN', null, 'Play! Pokemon',    'approved', 'seed', 0),
  ('SCRYDEX', 'playpokemonstamp',         'PLAY_POKEMON_STAMP', 'UNKNOWN', null, 'Play! Pokemon',    'approved', 'seed', 0),
  ('SCRYDEX', 'leaguestamp',              'LEAGUE_STAMP',       'UNKNOWN', null, 'League',           'approved', 'seed', 0),
  ('SCRYDEX', 'league1stplacestamp',      'LEAGUE_1ST_PLACE',   'UNKNOWN', null, 'League 1st Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league1stplace',           'LEAGUE_1ST_PLACE',   'UNKNOWN', null, 'League 1st Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league2ndplacestamp',      'LEAGUE_2ND_PLACE',   'UNKNOWN', null, 'League 2nd Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league2ndplace',           'LEAGUE_2ND_PLACE',   'UNKNOWN', null, 'League 2nd Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league3rdplacestamp',      'LEAGUE_3RD_PLACE',   'UNKNOWN', null, 'League 3rd Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league3rdplace',           'LEAGUE_3RD_PLACE',   'UNKNOWN', null, 'League 3rd Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league4thplacestamp',      'LEAGUE_4TH_PLACE',   'UNKNOWN', null, 'League 4th Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'league4thplace',           'LEAGUE_4TH_PLACE',   'UNKNOWN', null, 'League 4th Place', 'approved', 'seed', 0),
  ('SCRYDEX', 'staffstamp',               'STAFF_STAMP',        'UNKNOWN', null, 'Staff',            'approved', 'seed', 0),
  ('SCRYDEX', 'staff',                    'STAFF_STAMP',        'UNKNOWN', null, 'Staff',            'approved', 'seed', 0),
  ('SCRYDEX', 'holidaystamp',             'HOLIDAY_STAMP',      'UNKNOWN', null, 'Holiday',          'approved', 'seed', 0),
  ('SCRYDEX', 'expansionstamp',           'EXPANSION_STAMP',    'UNKNOWN', null, 'Expansion',        'approved', 'seed', 0),
  ('SCRYDEX', 'burgerkingstamp',          'BURGER_KING_STAMP',  'UNKNOWN', null, 'Burger King',      'approved', 'seed', 0),
  ('SCRYDEX', 'burgerking',               'BURGER_KING_STAMP',  'UNKNOWN', null, 'Burger King',      'approved', 'seed', 0),
  ('SCRYDEX', 'wstamp',                   'W_STAMP',            'UNKNOWN', null, 'W Stamp',          'approved', 'seed', 0),
  ('SCRYDEX', 'prereleasestamp',          'PRERELEASE',         'UNKNOWN', null, 'Prerelease',       'approved', 'seed', 0),
  ('SCRYDEX', 'prerelease',               'PRERELEASE',         'UNKNOWN', null, 'Prerelease',       'approved', 'seed', 0),

  ('SCRYDEX', 'peelabledittoholofoil', 'PEELABLE_DITTO', 'UNKNOWN', null, 'Peelable Ditto', 'approved', 'seed', 0),
  ('SCRYDEX', 'peelableditto',         'PEELABLE_DITTO', 'UNKNOWN', null, 'Peelable Ditto', 'approved', 'seed', 0),

  ('SCRYDEX', 'shadowless', 'SHADOWLESS', 'UNKNOWN', null, 'Shadowless', 'approved', 'seed', 0)
on conflict (provider, raw_token) do nothing;
