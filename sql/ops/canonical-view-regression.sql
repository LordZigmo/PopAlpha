-- canonical-view-regression.sql
--
-- Guard against Phase-1-style cohort-interleave regressions. Sample
-- multi-cohort slugs (slugs whose SCRYDEX snapshot history has more
-- than one distinct variant_ref) and assert public_price_history_canonical
-- returns exactly one variant_ref per slug. Any slug that returns 0 or >1
-- is a data-model gap worth investigating.
--
-- Thresholds (as of 2026-04-23, post Phase 3a):
--   Expected:  >= 99%  of multi-cohort slugs return 1 cohort
--   Residue:             pure-edition tokens (firstedition/unlimited/jumbo,
--                        artist autographs) still have printing_id NULL
--                        and are excluded from the canonical view —
--                        separate Phase 3b/c/d scope.
--
-- Run on demand or wire into a CI check when further phases land.

with multi_cohort as (
  select canonical_slug
  from public.price_history_points
  where provider = 'SCRYDEX'
    and source_window = 'snapshot'
    and variant_ref like '%::RAW'
    and variant_ref not like '%::GRADED::%'
  group by canonical_slug
  having count(distinct variant_ref) > 1
  order by canonical_slug
  limit 2000
),
cc as (
  select s.canonical_slug,
    (select count(distinct variant_ref)
       from public.public_price_history_canonical v
       where v.canonical_slug = s.canonical_slug) as cohort_count
  from multi_cohort s
)
select
  count(*) as sampled,
  sum(case when cohort_count = 1 then 1 else 0 end) as one_cohort,
  sum(case when cohort_count = 0 then 1 else 0 end) as zero_cohorts,
  sum(case when cohort_count > 1 then 1 else 0 end) as still_multi,
  round(100.0 * sum(case when cohort_count = 1 then 1 else 0 end) / count(*), 2) as pct_correct
from cc;
