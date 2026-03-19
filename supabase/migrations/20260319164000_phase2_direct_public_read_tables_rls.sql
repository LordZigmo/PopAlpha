-- Phase 2.5:
-- Enable row-level security on direct public-read tables while preserving
-- their anonymous/authenticated SELECT-only contract.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'canonical_cards',
    'card_aliases',
    'card_printings',
    'card_profiles',
    'deck_cards',
    'fx_rates',
    'printing_aliases'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select on table public.%I to anon, authenticated', table_name);
  end loop;
end
$$;

drop policy if exists canonical_cards_public_read on public.canonical_cards;
create policy canonical_cards_public_read
on public.canonical_cards
for select
to anon, authenticated
using (true);

drop policy if exists card_aliases_public_read on public.card_aliases;
create policy card_aliases_public_read
on public.card_aliases
for select
to anon, authenticated
using (true);

drop policy if exists card_printings_public_read on public.card_printings;
create policy card_printings_public_read
on public.card_printings
for select
to anon, authenticated
using (true);

drop policy if exists card_profiles_public_read on public.card_profiles;
create policy card_profiles_public_read
on public.card_profiles
for select
to anon, authenticated
using (true);

drop policy if exists deck_cards_public_read on public.deck_cards;
create policy deck_cards_public_read
on public.deck_cards
for select
to anon, authenticated
using (true);

drop policy if exists fx_rates_public_read on public.fx_rates;
create policy fx_rates_public_read
on public.fx_rates
for select
to anon, authenticated
using (true);

drop policy if exists printing_aliases_public_read on public.printing_aliases;
create policy printing_aliases_public_read
on public.printing_aliases
for select
to anon, authenticated
using (true);
