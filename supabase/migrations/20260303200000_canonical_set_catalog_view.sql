create or replace view public.canonical_set_catalog as
select
  cp.set_name,
  cp.year,
  count(*) as card_count,
  sum(case when cp.finish = 'UNKNOWN' then 1 else 0 end) as unknown_finish_count,
  public.normalize_set_id(cp.set_name) as set_id
from public.card_printings cp
where cp.set_name is not null
group by cp.set_name, cp.year;
