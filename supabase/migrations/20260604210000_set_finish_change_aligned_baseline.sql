-- 20260604210000_set_finish_change_aligned_baseline.sql
--
-- supersedes: 20260302110000_set_summary_pipeline.sql
--
-- Fix the SAME catastrophic %-inflation bug as 20260604200000, in the sibling
-- per-finish function that 20260604200000 did not touch. Live on 2026-06-05:
-- Twilight Masquerade NON_HOLO change_7d_pct = +41,902,700%, Temporal Forces
-- NON_HOLO = +37,840,300%, Mega Evolution NON_HOLO = +25,517,900%. This feeds
-- the per-finish breakdown on the set-detail page (web app/sets/[setName] and
-- iOS SetDetailView via public_set_finish_summary), so the garbage was visible
-- on both clients.
--
-- ROOT CAUSE (identical to the set-level bug): the change divided
--   market_cap    = sum(variant_price_latest.latest_price)  -- ALL cards, dense
--   market_cap_7d = sum(variant_price_daily.close_price)    -- only cards with a
--                                                              row EXACTLY 7d ago
-- via a LEFT JOIN at as_of_date = current_date - 7. Because variant_price_daily
-- is sparse on any single day (most cards aren't re-priced daily), the
-- denominator collapsed to a handful of cards while the numerator covered the
-- whole finish bucket -> denominator collapse -> tens of millions of percent.
--
-- THE FIX mirrors 20260604200000 exactly:
--   1. WINDOWED BASELINE via LATERAL: most-recent close in [t-8,t-6] (7d) /
--      [t-33,t-27] (30d) instead of one exact day. Survives a sparse day.
--   2. PER-CARD CAP: a card whose move exceeds +/-200% (7d) / +/-300% (30d) is a
--      near-zero-baseline artifact -> excluded from the basis (usable_* = false).
--   3. ALIGNED INTERSECTION: the per-finish change is summed over the SAME clean,
--      non-outlier cards on both ends (filter on usable_*), so numerator and
--      denominator always cover the identical population.
--   4. COVERAGE + BACKSTOP GUARDS: NULL the change when fewer than 3 cards, or
--      under 5% of the finish bucket, have a usable baseline, or if the aligned
--      result still exceeds the backstop (+/-200% 7d / +/-300% 30d).
--
-- Headline market_cap and card_count are UNCHANGED (sum of today's prices /
-- distinct slugs). Only the % CHANGE math changes. The truncate/delete + upsert
-- shape is preserved verbatim.

create or replace function public.refresh_set_finish_summary_latest(
  only_set_ids text[] DEFAULT NULL::text[]
)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  affected integer := 0;
begin
  if only_set_ids is null then
    truncate table public.set_finish_summary_latest;
  else
    delete from public.set_finish_summary_latest
    where set_id = any(only_set_ids);
  end if;

  insert into public.set_finish_summary_latest (
    set_id,
    set_name,
    finish,
    market_cap,
    card_count,
    change_7d_pct,
    change_30d_pct,
    updated_at
  )
  with filtered as (
    select *
    from public.variant_price_latest
    where set_id is not null
      and set_name is not null
      and (only_set_ids is null or set_id = any(only_set_ids))
  ),
  priced as (
    select
      f.set_id,
      f.set_name,
      f.finish,
      f.canonical_slug,
      f.latest_price,
      vpd7.close_price  as price_7d,
      vpd30.close_price as price_30d,
      -- A card counts toward the basis only when it has a windowed baseline
      -- AND the per-card move is within the plausibility cap (else it's a
      -- near-zero-baseline artifact that would distort the bucket).
      case
        when vpd7.close_price is null or vpd7.close_price <= 0 then false
        when abs(((f.latest_price - vpd7.close_price) / vpd7.close_price) * 100) > 200 then false
        else true
      end as usable_7d,
      case
        when vpd30.close_price is null or vpd30.close_price <= 0 then false
        when abs(((f.latest_price - vpd30.close_price) / vpd30.close_price) * 100) > 300 then false
        else true
      end as usable_30d
    from filtered f
    left join lateral (
      select b7.close_price
      from public.variant_price_daily b7
      where b7.provider = f.provider
        and b7.variant_ref = f.variant_ref
        and b7.grade = f.grade
        and b7.as_of_date between current_date - 8 and current_date - 6
        and b7.close_price > 0
      order by b7.as_of_date desc
      limit 1
    ) vpd7 on true
    left join lateral (
      select b30.close_price
      from public.variant_price_daily b30
      where b30.provider = f.provider
        and b30.variant_ref = f.variant_ref
        and b30.grade = f.grade
        and b30.as_of_date between current_date - 33 and current_date - 27
        and b30.close_price > 0
      order by b30.as_of_date desc
      limit 1
    ) vpd30 on true
  ),
  by_finish as (
    -- `priced` is aliased `vpl` here so the per-finish output expressions read
    -- exactly as the prior body did (the check-set-summary-view-contract.mjs CI
    -- guard pins these three literals: coalesce(vpl.finish...), count(distinct
    -- vpl.canonical_slug...), sum(vpl.latest_price...)). market_cap / card_count
    -- are byte-identical to the prior function; only the change math changed.
    select
      vpl.set_id,
      vpl.set_name,
      coalesce(vpl.finish, 'UNKNOWN') as finish,
      count(distinct vpl.canonical_slug) as card_count,
      count(*) as variant_count,
      sum(vpl.latest_price) as market_cap,
      sum(vpl.latest_price) filter (where vpl.usable_7d)  as cap_now_7d,
      sum(vpl.price_7d)     filter (where vpl.usable_7d)  as market_cap_7d,
      count(*)              filter (where vpl.usable_7d)  as aligned_7d,
      sum(vpl.latest_price) filter (where vpl.usable_30d) as cap_now_30d,
      sum(vpl.price_30d)    filter (where vpl.usable_30d) as market_cap_30d,
      count(*)              filter (where vpl.usable_30d) as aligned_30d
    from priced vpl
    group by vpl.set_id, vpl.set_name, coalesce(vpl.finish, 'UNKNOWN')
  )
  select
    bf.set_id,
    bf.set_name,
    bf.finish,
    coalesce(round(bf.market_cap, 2), 0),
    bf.card_count,
    case
      when bf.market_cap_7d is null or bf.market_cap_7d = 0 then null
      when bf.aligned_7d < 3 then null
      when bf.aligned_7d::numeric / nullif(bf.variant_count, 0) < 0.05 then null
      when abs(((bf.cap_now_7d - bf.market_cap_7d) / bf.market_cap_7d) * 100) > 200 then null
      else round(((bf.cap_now_7d - bf.market_cap_7d) / bf.market_cap_7d) * 100, 2)
    end,
    case
      when bf.market_cap_30d is null or bf.market_cap_30d = 0 then null
      when bf.aligned_30d < 3 then null
      when bf.aligned_30d::numeric / nullif(bf.variant_count, 0) < 0.05 then null
      when abs(((bf.cap_now_30d - bf.market_cap_30d) / bf.market_cap_30d) * 100) > 300 then null
      else round(((bf.cap_now_30d - bf.market_cap_30d) / bf.market_cap_30d) * 100, 2)
    end,
    now()
  from by_finish bf
  on conflict (set_id, finish)
  do update set
    set_name = excluded.set_name,
    market_cap = excluded.market_cap,
    card_count = excluded.card_count,
    change_7d_pct = excluded.change_7d_pct,
    change_30d_pct = excluded.change_30d_pct,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$function$;
