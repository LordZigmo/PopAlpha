-- JP freshest price + 14-day median, blended across Snkrdunk + Yahoo! JP.
--
-- The freshest+median price-display redesign (EN RAW canonical + per-printing
-- already shipped) extends to JP. JP has no dense daily snapshot series (it's
-- actual sold listings, ~weekly per card), so the median window is 14 days
-- (verified: a 3-day window prices only ~69 slugs — far too sparse).
--
-- Blended into ONE series (user-agreed, 2026-06-01: "blend JP and Yahoo into one
-- price series"). Conveniently, no (slug,printing,grade,day) ever carries both
-- Snkrdunk AND Yahoo on the same day, so the "blend" is just the union of points,
-- with a sample-count-weighted mean only when one source reports multiple times in
-- a single day.
--
-- Trust bar: sample_count >= 3 per observation — the SAME floor the existing JP
-- subsystem enforces (lib/pricing/jp-price-source.ts + public_jp_price_coverage:
-- a source qualifies only at >= 3 listings). Measured impact (14d window): all
-- 16,234 Snkrdunk points qualify (Snkrdunk is always >= 3); ~68% of Yahoo points
-- are thin (1-2 listings: e.g. the $0.20 / $1.03 noise) and drop out. Net: 4,351
-- of 5,383 keys retained (81%) — we'd rather show no JP price than a one-listing
-- one. Keeps the redesign's hero/median consistent with how JP already qualifies
-- prices everywhere else.
--
-- These land in DEDICATED jp_* columns, never the Scrydex-semantics latest_price /
-- display_price that `core` + the per-printing cron own, so the two price worlds
-- can't collide. public_card_metrics exposes them as ADDITIVE columns (raw
-- passthrough, like the existing yahoo_jp_price / snkrdunk_price) for iOS to read
-- as the JP hero (freshest) + "14-day median" sub-line. The base card_metrics
-- market_price for JP rows is unreliable (systematically a fraction of the true
-- sold price) but harmless: every JP display path already overrides/avoids it
-- (iOS selectJpPriceSource; web public_jp_price_coverage.display_price_usd). This
-- migration does not change that mapping — purely additive, zero regression.
--
-- Why NOT a bounded watermark cron (unlike refresh_per_printing_raw_price_display):
-- the per-printing refresh reads the multi-million-row price_history_points and
-- measured ~255s for ~49k rows, so it must be paced. JP reads jp_card_price_history
-- (~34k rows total) and a FULL ~90k-row pass measures ~4s. Pacing that would only
-- add a card_metrics-wide watermark index maintained by every EN refresh, for zero
-- benefit. So this is unbounded with a diff predicate (write only rows whose jp_*
-- actually changed) → first run writes the ~4.9k priced rows, steady state writes
-- just the daily delta. p_max_cards is retained as a defensive manual bound only.
--
-- supersedes: 20260601120000_freshest_price_and_per_printing_display.sql
--             (public_card_metrics — latest prior body. Diffed: every column, CTE,
--              guard and code path byte-for-byte identical EXCEPT four new trailing
--              output columns jp_latest_price / jp_latest_price_as_of /
--              jp_display_price / jp_display_price_as_of, raw passthrough of the new
--              base columns. No existing column dropped, reordered or repurposed.)

-- ---------------------------------------------------------------------------
-- 1. New JP display columns on card_metrics (dedicated; never collide with the
--    Scrydex-semantics latest_price / display_price).
-- ---------------------------------------------------------------------------
alter table public.card_metrics
  add column if not exists jp_latest_price numeric,
  add column if not exists jp_latest_price_as_of timestamptz,
  add column if not exists jp_display_price numeric,
  add column if not exists jp_display_price_as_of timestamptz;

-- ---------------------------------------------------------------------------
-- 2. refresh_jp_price_display — blended freshest + 14-day median from the JP
--    sold-listing time series. Unbounded (JP is ~4s for the full set) with a diff
--    predicate so only changed rows are written. NEW function (no prior body).
-- ---------------------------------------------------------------------------
create or replace function public.refresh_jp_price_display(p_max_cards int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  updated_count int := 0;
  cutoff_14d timestamptz := now() - interval '14 days';
begin
  with jp_scope as (
    -- All JP card_metrics rows (canonical + per-printing + grade variants).
    -- p_max_cards is a defensive manual bound; NULL (the cron default) = all.
    select cm.id as metric_id, cm.canonical_slug, cm.printing_id, cm.grade
    from public.card_metrics cm
    join public.canonical_cards cc on cc.slug = cm.canonical_slug
    where cc.language = 'JP'
    order by cm.id
    limit p_max_cards
  ),
  hist as (
    -- Trusted JP observations only: price > 0 AND sample_count >= 3 (mirrors the
    -- established JP qualifying bar). Match canonical (printing NULL) and
    -- per-printing rows via IS NOT DISTINCT FROM.
    select
      s.metric_id,
      h.observed_at,
      h.price_usd,
      greatest(coalesce(h.sample_count, 1), 1)::numeric as wt
    from jp_scope s
    join public.jp_card_price_history h
      on h.canonical_slug = s.canonical_slug
     and h.printing_id is not distinct from s.printing_id
     and h.grade = s.grade
    where h.price_usd is not null
      and h.price_usd > 0
      and coalesce(h.sample_count, 0) >= 3
      and h.observed_at >= cutoff_14d
  ),
  -- Blended daily value (sample-count-weighted; sources don't overlap within a day).
  daily as (
    select
      metric_id,
      date_trunc('day', observed_at) as day_ts,
      (sum(price_usd * wt) / nullif(sum(wt), 0))::numeric as day_price
    from hist
    group by metric_id, date_trunc('day', observed_at)
  ),
  latest_obs as (
    select distinct on (metric_id)
      metric_id, price_usd as latest_price, observed_at as latest_as_of
    from hist
    order by metric_id, observed_at desc
  ),
  median_14d as (
    select
      metric_id,
      (percentile_cont(0.5) within group (order by day_price))::numeric as median_price,
      max(day_ts) as median_as_of
    from daily
    group by metric_id
  ),
  vals as (
    select
      s.metric_id,
      lo.latest_price,
      lo.latest_as_of,
      m.median_price,
      m.median_as_of
    from jp_scope s
    left join latest_obs lo using (metric_id)
    left join median_14d m using (metric_id)
  ),
  do_update as (
    -- Diff predicate: only touch rows whose jp_* actually change (incl. clearing a
    -- price whose history aged out of the 14d window). NULL-vs-NULL is NOT DISTINCT,
    -- so the ~85k JP rows with no qualifying history are skipped every tick.
    update public.card_metrics cm
    set
      jp_latest_price = v.latest_price,
      jp_latest_price_as_of = v.latest_as_of,
      jp_display_price = v.median_price,
      jp_display_price_as_of = v.median_as_of
    from vals v
    where cm.id = v.metric_id
      and (
        cm.jp_latest_price is distinct from v.latest_price
        or cm.jp_latest_price_as_of is distinct from v.latest_as_of
        or cm.jp_display_price is distinct from v.median_price
        or cm.jp_display_price_as_of is distinct from v.median_as_of
      )
    returning 1
  )
  select count(*) into updated_count from do_update;

  return jsonb_build_object('jp_updated', updated_count);
end;
$$;

-- SECURITY DEFINER lockdown: writes card_metrics, so not callable by anon /
-- authenticated. The service-role cron bypasses grants.
revoke all on function public.refresh_jp_price_display(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. public_card_metrics — append the four JP display columns (additive only).
--    The entire body below is byte-identical to 20260601120000 except the four
--    trailing jp_* output columns in the final SELECT.
-- ---------------------------------------------------------------------------
create or replace view public.public_card_metrics as
with metric_rows as (
  select
    base_cm.*,
    (
      base_cm.grade = 'RAW'
      and base_cm.market_price is not null
      and coalesce(base_cm.snapshot_count_30d, 0) >= 5
      and base_cm.market_price > (
        greatest(
          coalesce(nullif(base_cm.median_7d, 0), 0),
          coalesce(nullif(base_cm.median_30d, 0), 0),
          coalesce(nullif(base_cm.trimmed_median_30d, 0), 0),
          coalesce(nullif(base_cm.low_30d, 0), 0),
          1
        ) * 20
      )
    ) as raw_market_price_outlier
  from public.card_metrics base_cm
),
joined_rows as (
  select
    cm.*,
    cc.canonical_name_native,
    cc.set_name_native,
    cc.language as canonical_language,
    (cc.language = 'EN' and cm.grade = 'RAW') as is_en_raw,
    ctrp.trust_status as private_trust_status,
    ctrp.trusted_price_usd as private_trusted_price_usd,
    ctrp.trusted_price_as_of as private_trusted_price_as_of,
    ctrp.trusted_price_source as private_trusted_price_source,
    ctrp.pricecharting_price_usd as private_guardrail_price_usd,
    ctrp.pricecharting_as_of as private_guardrail_as_of,
    ctrp.scrydex_price_usd as private_scrydex_price_usd,
    ctrp.scrydex_as_of as private_scrydex_as_of,
    ctrp.quarantine_reason as private_quarantine_reason,
    coalesce(yjp_specific.price_usd, yjp_canonical.price_usd) as yahoo_jp_price_out,
    coalesce(yjp_specific.price_jpy, yjp_canonical.price_jpy) as yahoo_jp_price_jpy_out,
    coalesce(yjp_specific.sample_count, yjp_canonical.sample_count) as yahoo_jp_sample_count_out,
    coalesce(yjp_specific.observed_at, yjp_canonical.observed_at) as yahoo_jp_observed_at_out,
    coalesce(snk_specific.price_usd, snk_canonical.price_usd) as snkrdunk_price_out,
    coalesce(snk_specific.sample_count, snk_canonical.sample_count) as snkrdunk_sample_count_out,
    coalesce(snk_specific.observed_at, snk_canonical.observed_at) as snkrdunk_observed_at_out,
    coalesce(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) as snkrdunk_product_code_out,
    coalesce(snk_specific.price_jpy, snk_canonical.price_jpy) as snkrdunk_price_jpy_out
  from metric_rows cm
  left join public.yahoo_jp_card_prices yjp_specific
    on yjp_specific.canonical_slug = cm.canonical_slug
   and yjp_specific.printing_id = cm.printing_id
   and yjp_specific.grade = cm.grade
  left join public.yahoo_jp_card_prices yjp_canonical
    on yjp_canonical.canonical_slug = cm.canonical_slug
   and yjp_canonical.printing_id is null
   and yjp_canonical.grade = cm.grade
  left join public.snkrdunk_card_prices snk_specific
    on snk_specific.canonical_slug = cm.canonical_slug
   and snk_specific.printing_id = cm.printing_id
   and snk_specific.grade = cm.grade
  left join public.snkrdunk_card_prices snk_canonical
    on snk_canonical.canonical_slug = cm.canonical_slug
   and snk_canonical.printing_id is null
   and snk_canonical.grade = cm.grade
  left join public.canonical_cards cc
    on cc.slug = cm.canonical_slug
  left join public.canonical_trusted_raw_prices ctrp
    on ctrp.canonical_slug = cm.canonical_slug
   and ctrp.printing_id is not distinct from cm.printing_id
),
public_price_policy as (
  select
    j.*,
    case
      when j.is_en_raw then
        -- Chart-series-truth: EN-RAW headline derives from the Scrydex daily
        -- snapshot median (display_price), the same series the chart plots.
        -- COALESCE to the prior basis when no snapshot series exists (chart is
        -- then sparse/empty too, so nothing to be inconsistent with). All
        -- suppression branches below still hard-null exactly as before.
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.display_price, j.private_trusted_price_usd)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.display_price, j.private_scrydex_price_usd, j.market_price)
          else coalesce(j.display_price, j.market_price)
        end
      when j.raw_market_price_outlier then null
      else j.market_price
    end as public_market_price,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                 end
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.market_price_as_of)
                 end
          else case
                 when j.display_price is not null then j.display_price_as_of
                 else j.market_price_as_of
               end
        end
      when j.raw_market_price_outlier then null
      else j.market_price_as_of
    end as public_market_price_as_of,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.private_scrydex_as_of, j.provider_compare_as_of)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.provider_compare_as_of)
          else j.provider_compare_as_of
        end
      when j.raw_market_price_outlier then null
      else j.provider_compare_as_of
    end as public_provider_compare_as_of
  from joined_rows j
),
public_signal_policy as (
  select
    p.*,
    -- Freshest hero price. Same suppression as the headline (null when the
    -- median headline is hidden). For EN-RAW: the freshest daily snapshot point,
    -- falling back to the median basis so the hero never blanks. For JP / graded
    -- (non-EN-RAW): mirror the headline price — their hero comes from JP-native /
    -- graded sources, not the Scrydex snapshot the latest_price column holds, so
    -- never surface a snapshot-derived freshest here (a later step wires their
    -- own freshest+median). One value per spot, never a competing basis.
    case
      when p.public_market_price is null then null
      when p.is_en_raw then coalesce(p.latest_price, p.public_market_price)
      else p.public_market_price
    end as public_latest_price,
    case
      when p.public_market_price is null then null
      when p.is_en_raw then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      else p.public_market_price_as_of
    end as public_latest_price_as_of,
    case
      when p.is_en_raw then
        -- Median-basis change so the hero and the change % are coherent. Use
        -- the display change when the headline itself came from display_price;
        -- otherwise fall back to the prior change basis under the same guard.
        case
          when p.public_market_price is null then null
          when p.display_price is not null then p.display_change_pct_24h
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then p.change_pct_24h
          else null
        end
      when p.raw_market_price_outlier then null
      else p.change_pct_24h
    end as public_change_pct_24h,
    case
      when p.is_en_raw then
        case
          when p.public_market_price is null then null
          when p.display_price is not null then p.display_change_pct_7d
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then p.change_pct_7d
          else null
        end
      when p.raw_market_price_outlier then null
      else p.change_pct_7d
    end as public_change_pct_7d,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 90
          when p.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then 0
          when p.raw_market_price_outlier
            then 0
          when p.public_market_price is not null
            then least(coalesce(p.market_confidence_score, 25), 35)
          else 0
        end
      when p.raw_market_price_outlier then 0
      else p.market_confidence_score
    end as public_confidence_score,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then false
          else true
        end
      when p.raw_market_price_outlier then true
      else p.market_low_confidence
    end as public_low_confidence,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 'POPALPHA_MARKET_CONFIDENT'
          when p.private_trust_status = 'PRICECHARTING_DIVERGED'
            then 'POPALPHA_MARKET_QUARANTINED'
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
            then 'NO_RELIABLE_PRICE'
          when p.raw_market_price_outlier
            then 'OUTLIER_SUPPRESSED'
          when p.public_market_price is not null
            then 'POPALPHA_MARKET_LOW_CONFIDENCE'
          else 'NO_RELIABLE_PRICE'
        end
      when p.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
      else p.market_blend_policy
    end as public_market_blend_policy
  from public_price_policy p
),
public_signal_context as (
  select
    s.*,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_price_usd
      else null
    end as recent_market_signal_usd,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_as_of
      else null
    end as recent_market_signal_as_of
  from public_signal_policy s
),
public_signal_gap as (
  select
    c.*,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
        then round((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric, 2)
      else null
    end as recent_market_signal_delta_pct,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd > c.public_market_price
        then 'HIGHER'
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd < c.public_market_price
        then 'LOWER'
      else null
    end as recent_market_signal_direction
  from public_signal_context c
),
public_display_policy as (
  select
    g.*,
    case
      when g.is_en_raw
       and (g.private_trust_status = 'PRICECHARTING_DIVERGED' or g.raw_market_price_outlier)
       and g.public_market_price is null
        then 'UNDER_REVIEW'
      when g.public_market_price is null
        then 'NO_RELIABLE_PRICE'
      when g.is_en_raw
       and g.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
        then 'PUBLIC_ONLY'
      when g.recent_market_signal_direction = 'HIGHER'
        then 'SIGNAL_HIGHER'
      when g.recent_market_signal_direction = 'LOWER'
        then 'SIGNAL_LOWER'
      else 'ALIGNED'
    end as market_price_display_state
  from public_signal_gap g
),
public_provenance_policy as (
  select
    s.*,
    case
      when s.is_en_raw then
        jsonb_strip_nulls(jsonb_build_object(
          'marketPriceLabel', 'PopAlpha Market Price',
          'marketPriceDisplayState', s.market_price_display_state,
          'recentMarketSignalDirection', s.recent_market_signal_direction,
          'recentMarketSignalDeltaPct', s.recent_market_signal_delta_pct,
          'confidenceStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
               and s.public_market_price is not null
                then 'HIGH'
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              when s.public_market_price is not null
                then 'LOW'
              else 'NONE'
            end,
          'publicInputStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                then 'INSUFFICIENT_PUBLIC_INPUT'
              when s.public_market_price is not null
                then 'SUPPORTED'
              else 'INSUFFICIENT_PUBLIC_INPUT'
            end,
          'priceConflictStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'INTERNAL_GUARDRAIL_DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'CONSISTENT'
              when s.public_market_price is not null
                then 'PUBLIC_INPUT_ONLY'
              else 'NONE'
            end,
          'internalGuardrailStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED' then 'DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 'CONSISTENT'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY' then 'PRIVATE_ONLY'
              else 'NOT_AVAILABLE'
            end,
          'priceAsOf', s.public_market_price_as_of,
          'movementHistorySource',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
                then 'PERMITTED_MARKET_INPUT'
              else null
            end,
          'quarantineReason',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'PUBLIC_INPUT_DIVERGED_FROM_INTERNAL_GUARDRAIL'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                then 'MISSING_PERMITTED_PUBLIC_INPUT'
              when s.raw_market_price_outlier and s.public_market_price is null
                then 'PUBLIC_INPUT_OUTLIER_SUPPRESSED'
              else null
            end,
          'parityStatus',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
               and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'MATCH'
              else 'MISSING_PROVIDER'
            end,
          'sourceMix',
            jsonb_build_object(
              'scrydexWeight',
                case when s.public_market_price is not null then 1 else 0 end,
              'publicInputWeight',
                case when s.public_market_price is not null then 1 else 0 end
            ),
          'sampleCounts7d',
            jsonb_build_object(
              'scrydex',
                case
                  when coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end,
              'public',
                case
                  when s.public_market_price is not null
                   and coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end
            )
        ))
      when s.raw_market_price_outlier then coalesce(s.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
      else s.market_provenance
    end as public_market_provenance
  from public_display_policy s
)
select
  id,
  canonical_slug,
  printing_id,
  grade,
  median_7d,
  median_30d,
  low_30d,
  high_30d,
  trimmed_median_30d,
  volatility_30d,
  liquidity_score,
  percentile_rank,
  scarcity_adjusted_value,
  active_listings_7d,
  snapshot_count_30d,
  provider_trend_slope_7d,
  provider_trend_slope_30d,
  provider_cov_price_7d,
  provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_min_price_all_time,
  provider_min_price_all_time_date,
  provider_max_price_all_time,
  provider_max_price_all_time_date,
  provider_as_of_ts,
  provider_price_changes_count_30d,
  justtcg_price,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as scrydex_price,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as pokemontcg_price,
  yahoo_jp_price_out as yahoo_jp_price,
  yahoo_jp_price_jpy_out as yahoo_jp_price_jpy,
  yahoo_jp_sample_count_out as yahoo_jp_sample_count,
  yahoo_jp_observed_at_out as yahoo_jp_observed_at,
  snkrdunk_price_out as snkrdunk_price,
  snkrdunk_sample_count_out as snkrdunk_sample_count,
  snkrdunk_observed_at_out as snkrdunk_observed_at,
  snkrdunk_product_code_out as snkrdunk_product_code,
  public_market_price as market_price,
  public_market_price_as_of as market_price_as_of,
  public_provider_compare_as_of as provider_compare_as_of,
  public_confidence_score as market_confidence_score,
  public_low_confidence as market_low_confidence,
  public_market_blend_policy as market_blend_policy,
  public_market_provenance as market_provenance,
  public_change_pct_24h as change_pct_24h,
  public_change_pct_7d as change_pct_7d,
  updated_at,
  canonical_name_native,
  set_name_native,
  canonical_language as language,
  snkrdunk_price_jpy_out as snkrdunk_price_jpy,
  market_price_display_state,
  recent_market_signal_usd,
  recent_market_signal_as_of,
  recent_market_signal_delta_pct,
  recent_market_signal_direction,
  -- New columns MUST be appended last: CREATE OR REPLACE VIEW only allows
  -- adding trailing columns, not reordering existing ones.
  public_latest_price as latest_price,
  public_latest_price_as_of as latest_price_as_of,
  -- JP-native freshest hero + 14-day median (additive; raw passthrough of the
  -- new base columns). NULL for non-JP rows. iOS reads these for the JP detail
  -- hero + "14-day median" sub-line; the base market_price stays untouched.
  jp_latest_price,
  jp_latest_price_as_of,
  jp_display_price,
  jp_display_price_as_of
from public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;
