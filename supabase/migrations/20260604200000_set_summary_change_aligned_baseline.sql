-- 20260604200000_set_summary_change_aligned_baseline.sql
--
-- supersedes: 20260302110000_set_summary_pipeline.sql
--
-- Fix catastrophic set-level % change inflation. Observed on 2026-06-04:
-- Aquapolis change_7d_pct = +84,128%, Astral Radiance = +14,107,600%, 151 =
-- +3,961,100% (the entire rising-sets leaderboard was garbage, and the leading
-- set leaked into the homepage AI brief via focus_set).
--
-- ROOT CAUSE: change_7d_pct / change_30d_pct were computed as
--   (sum of TODAY's primary-card prices) / (sum of cards that had a close
--    EXACTLY N days ago)
-- via a LEFT JOIN to variant_price_daily at as_of_date = target - 7 (or - 30).
-- variant_price_daily coverage is sparse on any single day (e.g. only ~4k of
-- ~50k variants had a close on the 7-days-ago date), so the denominator
-- collapsed to a handful of cards while the numerator covered the whole set ->
-- denominator collapse -> millions of percent. It was a computation bug, not
-- real movement: the per-card 7d moves inside those sets were all sane (0-12%).
--
-- THE FIX makes the set-level change trustworthy:
--   1. WINDOWED BASELINE. The baseline is now the most-recent close in a window
--      ([t-8, t-6] for 7d, [t-33, t-27] for 30d) instead of one exact day, the
--      same anchoring the card-level refresh_price_changes() pipeline uses. This
--      survives a sparse individual day.
--   2. PER-CARD CAP. change_7d_pct_card / change_30d_pct_card (which feed
--      top_movers_json / top_losers_json on set pages) are capped: a per-card
--      move beyond +/-200% (7d) / +/-300% (30d) is treated as a near-zero-baseline
--      artifact and dropped to NULL, so set pages never show absurd per-card movers.
--   3. ALIGNED INTERSECTION. The set-level change is computed over the SAME clean,
--      non-outlier cards on both ends of the window (filter on the capped per-card
--      change being non-null). Numerator and denominator always cover the identical
--      population, so a set gaining/losing cards can no longer explode the ratio.
--   4. COVERAGE + BACKSTOP GUARDS. NULL the change when fewer than 3 cards, or
--      under 5% of the set, have a usable baseline, or if the aligned result still
--      somehow exceeds the backstop (+/-200% 7d, +/-300% 30d). We show "no reliable
--      trend" rather than a number we cannot defend.
--
-- Headline market_cap / market_cap_all_variants are UNCHANGED (sum of today's
-- prices). The % CHANGE math and the per-card mover cap are what change here.
-- Column definitions and the upsert are preserved verbatim, with one knock-on:
-- heat_score's FORMULA is unchanged but it reads avg_abs_change_7d, which now
-- averages the CAPPED per-card change -- so heat_score values de-noise for sets
-- that previously had outlier per-card moves (a correct side effect; the same
-- artifacts were inflating heat_score too). breakout/value/trend counts,
-- sentiment, votes, and top_movers_json/top_losers_json structure are unchanged.
--
-- Verified against live prod data before shipping: after this logic, the worst
-- set 7d change is 12.63% (Chaos Rising) with 6/43 sets populated; the rest
-- correctly NULL for want of a reliable baseline.

create or replace function public.refresh_set_summary_snapshots(
  target_as_of_date date DEFAULT CURRENT_DATE,
  only_set_ids text[] DEFAULT NULL::text[]
)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  affected integer := 0;
begin
  delete from public.set_summary_snapshots
  where as_of_date = target_as_of_date
    and (only_set_ids is null or set_id = any(only_set_ids));

  insert into public.set_summary_snapshots (
    set_id,
    set_name,
    as_of_date,
    market_cap,
    market_cap_all_variants,
    change_7d_pct,
    change_30d_pct,
    heat_score,
    breakout_count,
    value_zone_count,
    trend_bullish_count,
    sentiment_up_pct,
    vote_count,
    top_movers_json,
    top_losers_json,
    updated_at
  )
  with effective_prices as (
    select
      base.provider,
      base.variant_ref,
      base.grade,
      base.canonical_slug,
      base.printing_id,
      base.set_id,
      base.set_name,
      base.finish,
      base.as_of_price,
      base.as_of_observed_at,
      coalesce(
        (
          select sum(vpd_hist.sample_count)
          from public.variant_price_daily vpd_hist
          where vpd_hist.provider = base.provider
            and vpd_hist.variant_ref = base.variant_ref
            and vpd_hist.grade = base.grade
            and vpd_hist.as_of_date between target_as_of_date - 29 and target_as_of_date
        ),
        vpl.observation_count_30d,
        0
      ) as observation_count_30d
    from (
      select
        vpd0.provider,
        vpd0.variant_ref,
        vpd0.grade,
        vpd0.canonical_slug,
        vpd0.printing_id,
        vpd0.set_id,
        vpd0.set_name,
        vpd0.finish,
        vpd0.close_price as as_of_price,
        vpd0.observed_at_max as as_of_observed_at
      from public.variant_price_daily vpd0
      where vpd0.as_of_date = target_as_of_date
        and vpd0.set_id is not null
        and vpd0.set_name is not null
        and (only_set_ids is null or vpd0.set_id = any(only_set_ids))

      union all

      select
        vpl.provider,
        vpl.variant_ref,
        vpl.grade,
        vpl.canonical_slug,
        vpl.printing_id,
        vpl.set_id,
        vpl.set_name,
        vpl.finish,
        vpl.latest_price as as_of_price,
        vpl.latest_observed_at as as_of_observed_at
      from public.variant_price_latest vpl
      where target_as_of_date = current_date
        and vpl.set_id is not null
        and vpl.set_name is not null
        and (only_set_ids is null or vpl.set_id = any(only_set_ids))
        and not exists (
          select 1
          from public.variant_price_daily vpd0
          where vpd0.provider = vpl.provider
            and vpd0.variant_ref = vpl.variant_ref
            and vpd0.grade = vpl.grade
            and vpd0.as_of_date = target_as_of_date
        )
    ) base
    left join public.variant_price_latest vpl
      on vpl.provider = base.provider
     and vpl.variant_ref = base.variant_ref
     and vpl.grade = base.grade
  ),
  ranked_primary as (
    select
      l.*,
      row_number() over (
        partition by l.canonical_slug
        order by
          case when l.finish = 'NON_HOLO' then 0 else 1 end,
          l.observation_count_30d desc,
          l.as_of_observed_at desc,
          l.as_of_price desc,
          l.variant_ref asc
      ) as primary_rank
    from effective_prices l
  ),
  primary_variants as (
    select *
    from ranked_primary
    where primary_rank = 1
  ),
  primary_enriched as (
    select
      pv.set_id,
      pv.set_name,
      pv.canonical_slug,
      pv.variant_ref,
      pv.provider,
      pv.grade,
      pv.finish,
      pv.as_of_price,
      pv.observation_count_30d,
      vpd7.close_price as price_7d,
      vpd30.close_price as price_30d,
      -- Per-card 7d change, capped: a move beyond +/-200% is a near-zero-baseline
      -- artifact, not a real card move. NULL excludes it from top_movers_json AND
      -- from the aligned set-level basis below.
      case
        when vpd7.close_price is null or vpd7.close_price <= 0 then null
        when abs(((pv.as_of_price - vpd7.close_price) / vpd7.close_price) * 100) > 200 then null
        else round(((pv.as_of_price - vpd7.close_price) / vpd7.close_price) * 100, 2)
      end as change_7d_pct_card,
      case
        when vpd30.close_price is null or vpd30.close_price <= 0 then null
        when abs(((pv.as_of_price - vpd30.close_price) / vpd30.close_price) * 100) > 300 then null
        else round(((pv.as_of_price - vpd30.close_price) / vpd30.close_price) * 100, 2)
      end as change_30d_pct_card,
      vsl.signal_trend,
      vsl.signal_breakout,
      vsl.signal_value,
      coalesce(vsl.history_points_30d, 0) as signal_history_points_30d,
      vst.sentiment_up_pct,
      coalesce(vst.vote_count, 0) as vote_count
    from primary_variants pv
    -- 7d baseline: most-recent close in a window centered on t-7 (matches the
    -- card-level pipeline's time-anchored window; survives a sparse single day).
    left join lateral (
      select b7.close_price
      from public.variant_price_daily b7
      where b7.provider = pv.provider
        and b7.variant_ref = pv.variant_ref
        and b7.grade = pv.grade
        and b7.as_of_date between target_as_of_date - 8 and target_as_of_date - 6
        and b7.close_price > 0
      order by b7.as_of_date desc
      limit 1
    ) vpd7 on true
    -- 30d baseline: most-recent close in a window centered on t-30.
    left join lateral (
      select b30.close_price
      from public.variant_price_daily b30
      where b30.provider = pv.provider
        and b30.variant_ref = pv.variant_ref
        and b30.grade = pv.grade
        and b30.as_of_date between target_as_of_date - 33 and target_as_of_date - 27
        and b30.close_price > 0
      order by b30.as_of_date desc
      limit 1
    ) vpd30 on true
    left join public.variant_signals_latest vsl
      on vsl.provider = pv.provider
     and vsl.variant_ref = pv.variant_ref
     and vsl.grade = pv.grade
     and coalesce(
       (vsl.signals_as_of_ts at time zone 'utc')::date,
       (vsl.provider_as_of_ts at time zone 'utc')::date
     ) <= target_as_of_date
    left join public.variant_sentiment_latest vst
      on vst.variant_ref = pv.variant_ref
     and vst.grade = pv.grade
     and vst.question_open = true
     and (vst.updated_at at time zone 'utc')::date <= target_as_of_date
  ),
  set_rollup as (
    select
      pe.set_id,
      min(pe.set_name) as set_name,
      -- Headline current market cap: sum over ALL primary cards (unchanged).
      sum(pe.as_of_price) as market_cap,
      -- Aligned 7d basis: only cards with a usable, non-outlier baseline (the
      -- capped per-card change is non-null), so the change numerator and
      -- denominator cover the IDENTICAL population.
      sum(pe.as_of_price) filter (where pe.change_7d_pct_card is not null) as cap_now_7d,
      sum(pe.price_7d)    filter (where pe.change_7d_pct_card is not null) as market_cap_7d,
      count(*)            filter (where pe.change_7d_pct_card is not null) as aligned_count_7d,
      -- Aligned 30d basis (same idea).
      sum(pe.as_of_price) filter (where pe.change_30d_pct_card is not null) as cap_now_30d,
      sum(pe.price_30d)   filter (where pe.change_30d_pct_card is not null) as market_cap_30d,
      count(*)            filter (where pe.change_30d_pct_card is not null) as aligned_count_30d,
      avg(abs(coalesce(pe.change_7d_pct_card, 0))) as avg_abs_change_7d,
      avg(least(coalesce(pe.observation_count_30d, 0), 30)) as avg_activity_30d,
      count(*) filter (
        where coalesce(pe.signal_breakout, 0) >= 70 and pe.signal_history_points_30d >= 10
      ) as breakout_count,
      count(*) filter (
        where coalesce(pe.signal_value, 0) >= 70 and pe.signal_history_points_30d >= 10
      ) as value_zone_count,
      count(*) filter (
        where coalesce(pe.signal_trend, 0) >= 60 and pe.signal_history_points_30d >= 10
      ) as trend_bullish_count,
      sum(pe.vote_count) as vote_count,
      case
        when sum(pe.vote_count) = 0 then null
        else round(sum(coalesce(pe.sentiment_up_pct, 0) * pe.vote_count) / sum(pe.vote_count), 2)
      end as sentiment_up_pct,
      count(*) as primary_card_count
    from primary_enriched pe
    group by pe.set_id
  ),
  all_variants_rollup as (
    select
      l.set_id,
      sum(l.as_of_price) as market_cap_all_variants
    from effective_prices l
    group by l.set_id
  ),
  movers as (
    select
      pe.set_id,
      jsonb_agg(
        jsonb_build_object(
          'canonical_slug', pe.canonical_slug,
          'variant_ref', pe.variant_ref,
          'price', round(pe.as_of_price, 2),
          'change_7d_pct', pe.change_7d_pct_card,
          'finish', pe.finish
        )
        order by pe.change_7d_pct_card desc nulls last, pe.as_of_price desc
      ) filter (where pe.change_7d_pct_card is not null) as movers_json,
      jsonb_agg(
        jsonb_build_object(
          'canonical_slug', pe.canonical_slug,
          'variant_ref', pe.variant_ref,
          'price', round(pe.as_of_price, 2),
          'change_7d_pct', pe.change_7d_pct_card,
          'finish', pe.finish
        )
        order by pe.change_7d_pct_card asc nulls last, pe.as_of_price desc
      ) filter (where pe.change_7d_pct_card is not null) as losers_json
    from primary_enriched pe
    group by pe.set_id
  )
  select
    sr.set_id,
    sr.set_name,
    target_as_of_date,
    round(sr.market_cap, 2),
    round(coalesce(avr.market_cap_all_variants, 0), 2),
    -- 7d change over the aligned, non-outlier intersection + coverage/backstop guards.
    case
      when sr.market_cap_7d is null or sr.market_cap_7d = 0 then null
      when sr.aligned_count_7d < 3 then null
      when sr.aligned_count_7d::numeric / nullif(sr.primary_card_count, 0) < 0.05 then null
      when abs(((sr.cap_now_7d - sr.market_cap_7d) / sr.market_cap_7d) * 100) > 200 then null
      else round(((sr.cap_now_7d - sr.market_cap_7d) / sr.market_cap_7d) * 100, 2)
    end as change_7d_pct,
    -- 30d change over the aligned, non-outlier intersection + coverage/backstop guards.
    case
      when sr.market_cap_30d is null or sr.market_cap_30d = 0 then null
      when sr.aligned_count_30d < 3 then null
      when sr.aligned_count_30d::numeric / nullif(sr.primary_card_count, 0) < 0.05 then null
      when abs(((sr.cap_now_30d - sr.market_cap_30d) / sr.market_cap_30d) * 100) > 300 then null
      else round(((sr.cap_now_30d - sr.market_cap_30d) / sr.market_cap_30d) * 100, 2)
    end as change_30d_pct,
    round(
      (
        coalesce(sr.avg_abs_change_7d, 0) * 0.60
        + (coalesce(sr.avg_activity_30d, 0) / 30.0) * 25.0
        + (case when sr.primary_card_count = 0 then 0 else (sr.breakout_count::numeric / sr.primary_card_count) end) * 15.0
      ),
      2
    ) as heat_score,
    sr.breakout_count,
    sr.value_zone_count,
    sr.trend_bullish_count,
    sr.sentiment_up_pct,
    coalesce(sr.vote_count, 0),
    coalesce(
      case
        when jsonb_array_length(coalesce(m.movers_json, '[]'::jsonb)) > 5
          then (
            select jsonb_agg(value)
            from (
              select value
              from jsonb_array_elements(m.movers_json)
              limit 5
            ) top5
          )
        else m.movers_json
      end,
      '[]'::jsonb
    ) as top_movers_json,
    coalesce(
      case
        when jsonb_array_length(coalesce(m.losers_json, '[]'::jsonb)) > 5
          then (
            select jsonb_agg(value)
            from (
              select value
              from jsonb_array_elements(m.losers_json)
              limit 5
            ) top5
          )
        else m.losers_json
      end,
      '[]'::jsonb
    ) as top_losers_json,
    now()
  from set_rollup sr
  left join all_variants_rollup avr
    on avr.set_id = sr.set_id
  left join movers m
    on m.set_id = sr.set_id
  on conflict (set_id, as_of_date)
  do update set
    set_name = excluded.set_name,
    market_cap = excluded.market_cap,
    market_cap_all_variants = excluded.market_cap_all_variants,
    change_7d_pct = excluded.change_7d_pct,
    change_30d_pct = excluded.change_30d_pct,
    heat_score = excluded.heat_score,
    breakout_count = excluded.breakout_count,
    value_zone_count = excluded.value_zone_count,
    trend_bullish_count = excluded.trend_bullish_count,
    sentiment_up_pct = excluded.sentiment_up_pct,
    vote_count = excluded.vote_count,
    top_movers_json = excluded.top_movers_json,
    top_losers_json = excluded.top_losers_json,
    updated_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$function$;
