create or replace view public.canonical_set_catalog as
select
  set_name,
  year,
  count(*) as card_count
from public.canonical_cards
where set_name is not null
group by set_name, year;
