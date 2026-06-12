-- 20260613150000_jp_display_basis_change.sql
--
-- supersedes: 20260602040000_jp_freshest_and_14d_median.sql
--             (refresh_jp_price_display — the function's ONLY prior definer,
--              verified by grepping every migration. Body reproduced VERBATIM
--              below; the only changes are additive: five delta-window cutoff
--              declarations, a display_medians CTE over the existing `daily`
--              series, two computed delta columns in `vals` (+ its LEFT JOIN),
--              and the two new columns in do_update's SET + diff predicate.
--              Diffed line-by-line: no existing line changes beyond the
--              trailing commas the appended columns require.)
-- supersedes: 20260607140000_pricecharting_single_source_suppress_outliers.sql
--             (public_card_metrics — the view's latest prior definer. The
--              fnbody guard only inspects functions, but the same latest-body
--              discipline applies to views. Body reproduced VERBATIM below;
--              the only changes are the JP-RAW branch in the public
--              change_pct_24h / change_pct_7d CASEs and two TRAILING
--              passthrough output columns. No column dropped, reordered or
--              repurposed.)
--
-- JP display-basis change: the change badge computed from the SAME series as
-- the displayed JP price. PR 4 of the JP price-trust sequence (20260612014500
-- writer partition -> PR #231 iOS badges -> 20260613120000 tier cadence).
-- Codex P2s on PR #231 flagged the basis mismatch; this is the promised
-- server-side fix.
--
-- MISMATCH
-- --------
-- JP-RAW rows in public_card_metrics show market_price = jp_display_price:
-- the 14-day median refresh_jp_price_display computes from the blended
-- (Snkrdunk + Yahoo! JP, sample_count >= 3) jp_card_price_history daily
-- series, in USD. But their public change_pct_24h/7d passes through the
-- card_metrics BASE columns written by compute_jp_card_price_changes
-- (20260520140000) — a DIFFERENT series: single best-source, point-to-point
-- (not median), JPY basis, widened windows. A JP card can show a blended
-- two-source median price wearing a single-source point-delta badge. EN
-- already solved exactly this class with display_change_pct_* computed from
-- the same daily series as the displayed median (20260531120000 columns,
-- 20260606140000 current formula).
--
-- FIX
-- ---
-- 1. card_metrics gains jp_display_change_pct_24h / jp_display_change_pct_7d
--    (numeric, ADD COLUMN IF NOT EXISTS — the 20260531120000 EN pattern).
-- 2. refresh_jp_price_display ALSO computes those deltas from the SAME
--    `daily` CTE it already builds for the 14d median: rolling 3-day-window
--    medians — median_now (day_ts > now-3d) vs median_24h (day_ts <= now-24h
--    and > now-4d) vs median_7d (day_ts <= now-7d and > now-10d), pct =
--    (now - then) / then * 100, NULL when either side is missing or the
--    baseline is zero. This is the EN display_values formula (20260606140000)
--    verbatim. Note: the deltas compare ROLLING 3-DAY medians of the series,
--    not the 14d display median against itself (which would damp and lag by
--    a week) — same-series is the parity that matters, and it is exactly how
--    EN's hero/badge pair works.
-- 3. Currency: USD (price_usd), deliberately. The displayed jp_display_price
--    IS the USD median of this series, so USD deltas are the only choice
--    whose movement always agrees with the price users see.
--    compute_jp_card_price_changes computes in JPY to keep FX drift out of
--    its source-pure ratios (right for its series); recomputing THESE deltas
--    in JPY would re-introduce a second basis that can visibly disagree with
--    the displayed USD price's movement — the exact class of mismatch this
--    migration removes. Daily FX drift is small (typically well under
--    1%/day), and the JPY-basis base change remains the fallback.
-- 4. public_card_metrics: JP-RAW rows prefer the display-basis deltas when
--    non-null; the fallback preserves the prior passthrough EXACTLY (outlier
--    guard -> null, else base change_pct_24h/7d). Sparse JP series -> display
--    deltas NULL -> badge behavior identical to today, honestly. The two new
--    base columns are also surfaced as trailing raw passthrough view columns
--    so clients/debugging can attribute a JP badge's basis.
--
-- APPLY-TIME BOUND
-- ----------------
-- The one-shot refresh_jp_price_display() at the end is the function's normal
-- UNBOUNDED full pass — no watermark, no batching, default p_max_cards NULL =
-- all JP rows, exactly how the hourly cron calls it
-- (app/api/cron/refresh-jp-price-display/route.ts). Full pass measured ~0.8-4s
-- (~90k JP card_metrics rows against the ~34k-row jp_card_price_history; see
-- 20260602040000 header), so apply-time work is bounded and the new columns
-- are fully populated at apply — no partial-coverage window.

-- ---------------------------------------------------------------------------
-- 1. New JP display-basis change columns on card_metrics. Dedicated jp_*
--    family (sibling of jp_latest_price / jp_display_price), never colliding
--    with the EN-owned display_change_pct_* columns.
-- ---------------------------------------------------------------------------
alter table public.card_metrics
  add column if not exists jp_display_change_pct_24h numeric,
  add column if not exists jp_display_change_pct_7d numeric;

-- ---------------------------------------------------------------------------
-- 2. refresh_jp_price_display — body VERBATIM from 20260602040000 (sole prior
--    definer) plus the additive display-basis delta computation listed in the
--    file header. Same signature, so the cron call site is untouched.
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
  -- Rolling 3-day-median windows for the display-basis change. Same names,
  -- values and window semantics as the EN display_values formula
  -- (20260606140000) so the two implementations stay diffable. All windows sit
  -- inside the 14d lookback `hist` already applies, so no extra history is read.
  cutoff_3d timestamptz := now() - interval '3 days';
  cutoff_4d timestamptz := now() - interval '4 days';
  cutoff_24h timestamptz := now() - interval '24 hours';
  cutoff_7d timestamptz := now() - interval '7 days';
  cutoff_10d timestamptz := now() - interval '10 days';
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
  -- Display-basis change inputs: rolling 3-day-window medians over the SAME
  -- `daily` series the 14d median above is taken from, mirroring the EN
  -- display_values formula (20260606140000) verbatim. On today's typical
  -- sparse JP series (~weekly points) one side is usually missing -> NULL ->
  -- honestly no badge; the JP tier cadence (20260613120000) densifies hot
  -- cards to daily, so these activate progressively.
  display_medians as (
    select
      metric_id,
      (percentile_cont(0.5) within group (order by day_price)
        filter (where day_ts > cutoff_3d))::numeric as median_now,
      (percentile_cont(0.5) within group (order by day_price)
        filter (where day_ts <= cutoff_24h and day_ts > cutoff_4d))::numeric as median_24h,
      (percentile_cont(0.5) within group (order by day_price)
        filter (where day_ts <= cutoff_7d and day_ts > cutoff_10d))::numeric as median_7d
    from daily
    group by metric_id
  ),
  vals as (
    select
      s.metric_id,
      lo.latest_price,
      lo.latest_as_of,
      m.median_price,
      m.median_as_of,
      -- pct = (now - then) / then * 100; NULL when either side is missing or
      -- the baseline is zero (EN display_values formula, 20260606140000).
      case
        when dm.median_now is not null
         and dm.median_24h is not null
         and dm.median_24h > 0
        then ((dm.median_now - dm.median_24h) / dm.median_24h) * 100
        else null
      end as display_change_pct_24h,
      case
        when dm.median_now is not null
         and dm.median_7d is not null
         and dm.median_7d > 0
        then ((dm.median_now - dm.median_7d) / dm.median_7d) * 100
        else null
      end as display_change_pct_7d
    from jp_scope s
    left join latest_obs lo using (metric_id)
    left join median_14d m using (metric_id)
    left join display_medians dm using (metric_id)
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
      jp_display_price_as_of = v.median_as_of,
      jp_display_change_pct_24h = v.display_change_pct_24h,
      jp_display_change_pct_7d = v.display_change_pct_7d
    from vals v
    where cm.id = v.metric_id
      and (
        cm.jp_latest_price is distinct from v.latest_price
        or cm.jp_latest_price_as_of is distinct from v.latest_as_of
        or cm.jp_display_price is distinct from v.median_price
        or cm.jp_display_price_as_of is distinct from v.median_as_of
        or cm.jp_display_change_pct_24h is distinct from v.display_change_pct_24h
        or cm.jp_display_change_pct_7d is distinct from v.display_change_pct_7d
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
-- 3. public_card_metrics — body VERBATIM from 20260607140000 (latest prior
--    definer) plus the JP-RAW display-basis branch in the two public change
--    CASEs and two trailing passthrough columns. New columns MUST be appended
--    last: CREATE OR REPLACE VIEW only allows adding trailing columns.
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
    ctrp.pricecharting_change_pct_24h as private_pricecharting_change_pct_24h,
    ctrp.pricecharting_change_pct_7d as private_pricecharting_change_pct_7d,
    -- Sample-count gate for the single-source PriceCharting display branch.
    coalesce(ctrp.pricecharting_observations_7d, 0) as private_pricecharting_observations_7d,
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
          -- Well-sampled single-source PriceCharting: surface the PriceCharting
          -- price (mirrors the MATCH branch's source — for PRIMARY rows
          -- private_trusted_price_usd IS the PriceCharting price). Labeled
          -- low-confidence downstream. Thin PRIMARY still hard-nulls.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
            then coalesce(j.display_price, j.private_trusted_price_usd)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.display_price, j.private_scrydex_price_usd, j.market_price)
          else coalesce(j.display_price, j.market_price)
        end
      -- Graded (grade <> 'RAW'): the 14-day median display price (freshest+median
      -- redesign). Graded market_price is always NULL today, so this is purely
      -- additive — coalesce only ever resolves to display_price.
      when j.grade <> 'RAW' then coalesce(j.display_price, j.market_price)
      -- JP RAW: the base market_price is SCRYDEX_PRIMARY (a thin/wrong US-market
      -- price for JP cards). Use the JP-native 14-day median instead; NULL when
      -- there's no qualifying JP series (honest, not the Scrydex garbage).
      when j.canonical_language = 'JP' and j.grade = 'RAW' then j.jp_display_price
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
          -- Single-source PriceCharting as_of mirrors the MATCH branch: the
          -- display series' as_of when display_price drove the headline, else
          -- the PriceCharting (trusted) as_of.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
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
      when j.grade <> 'RAW' then
        case when j.display_price is not null then j.display_price_as_of else j.market_price_as_of end
      when j.canonical_language = 'JP' and j.grade = 'RAW' then j.jp_display_price_as_of
      when j.raw_market_price_outlier then null
      else j.market_price_as_of
    end as public_market_price_as_of,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.private_scrydex_as_of, j.provider_compare_as_of)
          -- Single-source PriceCharting has no Scrydex provider to compare
          -- against; fall back to the PriceCharting (trusted) as_of so the
          -- provider-compare timestamp isn't blanked while the price shows.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
            then coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.provider_compare_as_of)
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
      -- Graded hero = freshest sold point, falling back to the 14d-median headline.
      when p.grade <> 'RAW' then coalesce(p.latest_price, p.public_market_price)
      when p.canonical_language = 'JP' and p.grade = 'RAW' then coalesce(p.jp_latest_price, p.public_market_price)
      else p.public_market_price
    end as public_latest_price,
    case
      when p.public_market_price is null then null
      when p.is_en_raw then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      when p.grade <> 'RAW' then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      when p.canonical_language = 'JP' and p.grade = 'RAW' then coalesce(p.jp_latest_price_as_of, p.public_market_price_as_of)
      else p.public_market_price_as_of
    end as public_latest_price_as_of,
    case
      when p.is_en_raw then
        -- Median-basis change so the hero and the change % are coherent. Use
        -- the display change when the headline itself came from display_price;
        -- otherwise fall back to the prior change basis under the same guard.
        case
          when p.public_market_price is null then null
          -- Single-source PriceCharting: deliberately NO change badge. MUST run
          -- before the display-change fallback — the single-source headline is now
          -- non-null, so a stray display_change_pct_24h would otherwise leak a
          -- movement % onto a low-confidence single-source price.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
            then null
          when p.display_price is not null and p.display_change_pct_24h is not null
            then p.display_change_pct_24h
          -- Price-corroborated (MATCH) cards: prefer the Scrydex-derived change;
          -- fall back to PopAlpha's PriceCharting-derived change (outlier-capped
          -- at |%| <= 200, matching the Scrydex path) when Scrydex's is absent.
          -- Both are our own computations; the two-source price corroboration is
          -- what keeps it trustworthy. Non-MATCH stays null (conservative).
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(
              p.change_pct_24h,
              case when abs(p.private_pricecharting_change_pct_24h) <= 200
                     and p.private_guardrail_as_of >= now() - interval '48 hours'
                   then p.private_pricecharting_change_pct_24h else null end
            )
          -- Everything else (non-MATCH corroborated paths) stays null — conservative.
          -- Single-source is already nulled above, ahead of the display fallback.
          else null
        end
      -- JP RAW: display-basis change. refresh_jp_price_display derives these
      -- from the SAME blended daily series that produces the jp_display_price
      -- headline above, so the badge basis matches the price basis exactly
      -- (EN's display_change parity, JP edition). Sits BEFORE the outlier
      -- guard for the same reason the JP price branch does: the outlier flag
      -- is about the Scrydex-basis base market_price, which the JP display
      -- path never uses. The fallback preserves the prior passthrough EXACTLY
      -- (outlier -> null, else the base change from
      -- compute_jp_card_price_changes) for series too sparse for a
      -- display-basis delta.
      when p.canonical_language = 'JP' and p.grade = 'RAW' then
        coalesce(
          p.jp_display_change_pct_24h,
          case when p.raw_market_price_outlier then null else p.change_pct_24h end
        )
      when p.raw_market_price_outlier then null
      else p.change_pct_24h
    end as public_change_pct_24h,
    case
      when p.is_en_raw then
        case
          when p.public_market_price is null then null
          -- Single-source PriceCharting: no change badge (see 24h note) — guard runs
          -- before the display-change fallback.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
            then null
          when p.display_price is not null and p.display_change_pct_7d is not null
            then p.display_change_pct_7d
          -- Price-corroborated (MATCH) cards: prefer the Scrydex-derived change;
          -- fall back to PopAlpha's PriceCharting-derived change (outlier-capped
          -- at |%| <= 200, matching the Scrydex path) when Scrydex's is absent.
          -- Both are our own computations; the two-source price corroboration is
          -- what keeps it trustworthy. Non-MATCH stays null (conservative).
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(
              p.change_pct_7d,
              case when abs(p.private_pricecharting_change_pct_7d) <= 200
                     and p.private_guardrail_as_of >= now() - interval '48 hours'
                   then p.private_pricecharting_change_pct_7d else null end
            )
          -- Everything else stays null (single-source nulled above).
          else null
        end
      -- JP RAW: display-basis change — see the 24h note above.
      when p.canonical_language = 'JP' and p.grade = 'RAW' then
        coalesce(
          p.jp_display_change_pct_7d,
          case when p.raw_market_price_outlier then null else p.change_pct_7d end
        )
      when p.raw_market_price_outlier then null
      else p.change_pct_7d
    end as public_change_pct_7d,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 90
          -- Well-sampled single-source PriceCharting: low confidence (30). The
          -- price is surfaced but explicitly de-rated vs the 90 of a
          -- two-source MATCH and the 35 cap of a public-input low-confidence row.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then 30
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
          -- Single-source PriceCharting is low confidence by construction.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then true
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
          -- Well-sampled single-source PriceCharting headline.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then 'POPALPHA_MARKET_SINGLE_SOURCE'
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
      -- Single-source PriceCharting display state (the price is non-null, so
      -- this lands before the signal-direction/ALIGNED states below).
      when g.is_en_raw
       and g.private_trust_status = 'PRICECHARTING_PRIMARY'
       and g.private_pricecharting_observations_7d >= 5
        then 'PRICECHARTING_SINGLE_SOURCE'
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
              -- Single-source PriceCharting has a permitted public input (the
              -- PriceCharting feed), even without Scrydex corroboration.
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
               and s.private_pricecharting_observations_7d >= 5
               and s.public_market_price is not null
                then 'SUPPORTED'
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
              -- Thin (<5 obs) PRIMARY still reports the missing-input reason;
              -- well-sampled PRIMARY surfaces a price, so no quarantine reason.
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
               and s.public_market_price is null
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
              -- Single-source PriceCharting (PRIMARY) has a price but NO Scrydex —
              -- claim zero Scrydex weight so source-mix consumers aren't misled.
              'scrydexWeight',
                case when s.public_market_price is not null
                      and coalesce(s.private_trust_status, '') <> 'PRICECHARTING_PRIMARY'
                     then 1 else 0 end,
              'publicInputWeight',
                case when s.public_market_price is not null then 1 else 0 end
            ),
          'sampleCounts7d',
            jsonb_build_object(
              -- Single-source PriceCharting: no Scrydex sales (scrydex 0), and the
              -- public sample is the PriceCharting obs that passed the >=5 gate —
              -- not the absent/stale Scrydex count — so the row isn't seen as
              -- unsampled by UI / strength logic.
              'scrydex',
                case
                  when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                   and s.private_pricecharting_observations_7d >= 5
                   and s.public_market_price is not null
                    then 0
                  when coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end,
              'public',
                case
                  when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                   and s.private_pricecharting_observations_7d >= 5
                   and s.public_market_price is not null
                    then s.private_pricecharting_observations_7d
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
  jp_display_price_as_of,
  -- JP display-basis deltas (additive; raw passthrough of the new base
  -- columns). NULL for non-JP rows. Surfaced verbatim — alongside the
  -- blended change_pct_24h/7d above — so clients and debugging can attribute
  -- which basis a JP badge came from.
  jp_display_change_pct_24h,
  jp_display_change_pct_7d
from public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. One-shot apply-time run (same pattern as 20260520140000 /
--    20260612014500): populates jp_display_change_pct_* immediately instead
--    of waiting up to an hour for the next refresh-jp-price-display cron
--    tick. This is the normal unbounded full pass (~0.8-4s; see APPLY-TIME
--    BOUND above) — it covers every JP row, not a batch.
-- ---------------------------------------------------------------------------
select public.refresh_jp_price_display();
