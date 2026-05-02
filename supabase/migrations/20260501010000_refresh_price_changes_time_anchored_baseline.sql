-- 20260501010000_refresh_price_changes_time_anchored_baseline.sql
--
-- Fixes a systemic data-quality bug where change_pct_24h and change_pct_7d
-- on card_metrics were inflated for sparsely-traded cards.
--
-- Previous behaviour (migration 20260303115000): the 24h baseline was
-- "the most recent observation at-or-before now-24h", picked via
-- `WHERE rp.ts <= cutoff_24h` + `DISTINCT ON ... ORDER BY ts DESC`.
-- For vintage cards with only 1-2 observations in 30 days, the chosen
-- baseline was often weeks old, so the function computed
-- ((today - 3-weeks-ago) / 3-weeks-ago) * 100 and wrote it to a column
-- *labeled* change_pct_24h. The same shape applied to change_pct_7d.
--
-- The bad value then propagated unchecked to:
--   - card detail header change badge (via lib/data/assets.ts)
--   - homepage Top Movers / Biggest Drops live query (lib/data/homepage.ts)
--   - daily_top_movers cron table (caches 24h)
--   - AI homepage brief (lib/ai/homepage-brief.ts topByChange)
--   - search / sets / iOS Signal Board (all read public_card_metrics)
--
-- Stock-tracker convention applies: don't invent a number — show NULL when
-- the data does not actually support the named window.
--
-- New behaviour: a baseline is admissible only if it falls within ±6h of
-- "24h ago" (window [now-30h, now-18h]) for change_pct_24h, and within ±1d
-- of "7d ago" (window [now-8d, now-6d]) for change_pct_7d. An additional
-- outlier cap of |%| <= 200 catches any future regression that produces a
-- mathematically-valid-but-implausible result.
--
-- After redefining the function, the migration calls it once so existing
-- inflated rows are cleared immediately. The function itself sets
-- statement_timeout = 0 / lock_timeout = 0; the cardinality of card_metrics
-- (~tens of thousands of canonical RAW rows) makes a single sweep fast.

create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  nulled_count  int := 0;
  cutoff_8d            timestamptz := now() - interval '8 days';
  cutoff_24h_recent    timestamptz := now() - interval '24 hours';
  cutoff_7d_recent     timestamptz := now() - interval '7 days';
  -- Time-anchored baseline windows. The baseline must fall inside these,
  -- not just "before the cutoff." This is what stops "today vs 3-weeks-ago"
  -- being labeled as 24h change.
  baseline_24h_lo      timestamptz := now() - interval '30 hours';
  baseline_24h_hi      timestamptz := now() - interval '18 hours';
  baseline_7d_lo       timestamptz := now() - interval '8 days';
  baseline_7d_hi       timestamptz := now() - interval '6 days';
  -- Sanity ceiling. >200% in 24h on a normal-priced card is virtually
  -- always bad data; suppress to NULL rather than letting it through.
  outlier_cap_pct      numeric     := 200;
begin
  with recent_points as (
    select
      canonical_slug,
      variant_ref,
      ts,
      price
    from public.price_history_points
    where provider = 'JUSTTCG'
      and source_window = '30d'
      and ts >= cutoff_8d
  ),
  variant_stats as (
    select
      canonical_slug,
      variant_ref,
      count(*) as point_count,
      max(ts)  as latest_ts
    from recent_points
    group by canonical_slug, variant_ref
  ),
  best_variant as (
    select distinct on (canonical_slug)
      canonical_slug,
      variant_ref
    from variant_stats
    order by canonical_slug, point_count desc, latest_ts desc nulls last
  ),
  latest_price as (
    select distinct on (rp.canonical_slug)
      rp.canonical_slug,
      rp.price as price_now,
      rp.ts    as latest_ts
    from recent_points rp
    join best_variant bv using (canonical_slug, variant_ref)
    order by rp.canonical_slug, rp.ts desc
  ),
  -- Time-anchored 24h baseline: observation must fall in [now-30h, now-18h].
  price_at_24h as (
    select distinct on (rp.canonical_slug)
      rp.canonical_slug,
      rp.price as price_24h,
      rp.ts    as price_24h_ts
    from recent_points rp
    join best_variant bv using (canonical_slug, variant_ref)
    where rp.ts between baseline_24h_lo and baseline_24h_hi
    order by rp.canonical_slug, rp.ts desc
  ),
  -- Time-anchored 7d baseline: observation must fall in [now-8d, now-6d].
  price_at_7d as (
    select distinct on (rp.canonical_slug)
      rp.canonical_slug,
      rp.price as price_7d,
      rp.ts    as price_7d_ts
    from recent_points rp
    join best_variant bv using (canonical_slug, variant_ref)
    where rp.ts between baseline_7d_lo and baseline_7d_hi
    order by rp.canonical_slug, rp.ts desc
  ),
  changes as (
    select
      lp.canonical_slug,
      lp.price_now,
      lp.latest_ts,
      case
        when p24.price_24h is not null
         and p24.price_24h > 0
         and lp.latest_ts > cutoff_24h_recent
         and abs(((lp.price_now - p24.price_24h) / p24.price_24h) * 100) <= outlier_cap_pct
        then ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when p7.price_7d is not null
         and p7.price_7d > 0
         and lp.latest_ts > cutoff_7d_recent
         and abs(((lp.price_now - p7.price_7d) / p7.price_7d) * 100) <= outlier_cap_pct
        then ((lp.price_now - p7.price_7d) / p7.price_7d) * 100
        else null
      end as change_pct_7d
    from latest_price lp
    left join price_at_24h p24 using (canonical_slug)
    left join price_at_7d  p7  using (canonical_slug)
  ),
  do_update as (
    update public.card_metrics cm
    set
      market_price       = c.price_now,
      market_price_as_of = c.latest_ts,
      change_pct_24h     = c.change_pct_24h,
      change_pct_7d      = c.change_pct_7d
    from changes c
    where cm.canonical_slug = c.canonical_slug
      and cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.market_price       is distinct from c.price_now
        or cm.market_price_as_of is distinct from c.latest_ts
        or cm.change_pct_24h    is distinct from c.change_pct_24h
        or cm.change_pct_7d     is distinct from c.change_pct_7d
      )
    returning cm.id
  )
  select count(*) into updated_count from do_update;

  -- NULL-out rows for slugs that no longer have any qualifying recent JustTCG
  -- history at all. Same shape as the previous migration; baseline-window
  -- changes don't affect this branch.
  with slugs_with_history as (
    select distinct canonical_slug
    from public.price_history_points
    where provider = 'JUSTTCG'
      and source_window = '30d'
      and ts >= cutoff_8d
  ),
  do_null as (
    update public.card_metrics cm
    set
      market_price       = null,
      market_price_as_of = null,
      change_pct_24h     = null,
      change_pct_7d      = null
    where cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.market_price       is not null
        or cm.market_price_as_of is not null
        or cm.change_pct_24h    is not null
        or cm.change_pct_7d     is not null
      )
      and cm.canonical_slug not in (select canonical_slug from slugs_with_history)
    returning cm.id
  )
  select count(*) into nulled_count from do_null;

  return jsonb_build_object(
    'updated', updated_count,
    'nulled',  nulled_count
  );
end;
$$;

-- Re-evaluate every row immediately under the new rule so the bug stops
-- biting the homepage / detail pages without waiting for the next
-- /api/cron/refresh-card-metrics tick (which runs every 12h).
select public.refresh_price_changes();
