-- 20260614150000_jp_tiered_display_floor.sql
--
-- supersedes: 20260613220000_jp_metric_row_unlock.sql
--             (refresh_jp_price_display — the latest prior definer. Body
--              reproduced VERBATIM below. Declared changes ONLY: (1) the
--              metric-row INSERT floor drops coalesce(sample_count,0) >= 3
--              to >= 1, with its comment; (2) `hist` gains a trailing
--              h.sample_count column (attribution only — no existing
--              consumer reads it); (3) six new CTEs between display_medians
--              and vals — trusted_samples plus the thin_* chain (thin_hist,
--              thin_daily, thin_latest_obs, thin_median_14d, thin_samples);
--              (4) in `vals`, the four price/as_of columns gain a
--              trusted-first COALESCE over the thin chain, a new
--              display_sample_count column is appended, and four LEFT JOINs
--              are added — the two delta CASEs are byte-identical and still
--              read the TRUSTED display_medians only; (5) do_update's SET
--              and diff predicate gain jp_display_sample_count. The return
--              shape and the revoke are unchanged.)
-- supersedes: 20260613150000_jp_display_basis_change.sql
--             (public_card_metrics — the view's latest prior definer. The
--              fnbody guard only inspects functions, but the same
--              latest-body discipline applies to views. Body reproduced
--              VERBATIM below. Declared changes ONLY: five additive
--              thin-tier WHEN branches — hard-NULL public change_pct_24h /
--              change_pct_7d AHEAD of the JP coalesce fallback, confidence
--              30, market_low_confidence true, market_price_display_state
--              'JP_LOW_SAMPLE' — plus ONE trailing passthrough column,
--              jp_display_sample_count. Every new branch is keyed on
--              canonical_language = 'JP' AND grade = 'RAW' AND
--              jp_display_price IS NOT NULL AND jp_display_sample_count < 3,
--              so it can never match a non-JP row, a trusted (>= 3) row, or
--              a legacy NULL-sample-count row. No column dropped, reordered
--              or repurposed.)
--
-- JP tiered display floor — option B of the approved display-policy design,
-- server side. Sequence: Snkrdunk low-sample writes + change-delta sample
-- floor (#245, 20260614120000) -> THIS PR (display floor + trust labeling)
-- -> iOS low-sample subline (separate PR).
--
-- PROBLEM
-- -------
-- Every JP display path keys off the >= 3-sample qualifying bar, so a JP
-- card whose entire 14d canonical RAW series is 1-2-sample observations
-- displays NOTHING — not even a labeled low-confidence price. Measured on
-- prod 2026-06-12: 1,423 JP slugs have in-window (14d, price_usd > 0)
-- canonical RAW history where EVERY row is sample_count 1-2 (vs 3,856
-- trusted slugs); 0 of the 1,423 display a price today. 1,171 of them
-- already have a canonical RAW card_metrics row (the UPDATE path fills
-- them); 252 have no row and need the metric-row INSERT below. EN solved
-- exactly this class with the single-source PriceCharting grammar
-- (20260607130000): surface the price, de-rate it (confidence 30), flag it
-- low-confidence, label the display state, suppress the change badge. This
-- migration is that grammar, JP edition.
--
-- TWO-TIER SERIES (why >= 3-sample cards stay bit-identical)
-- ----------------------------------------------------------
-- * TRUSTED pass: today's `hist` CTE (sample_count >= 3) and its whole
--   downstream chain (daily -> latest_obs / median_14d / display_medians)
--   are reproduced byte-identical. Everything it produces — including
--   jp_display_change_pct_24h/7d — is unchanged; deltas come from the
--   TRUSTED series ONLY.
-- * THIN pass: qualifying rows at sample_count >= 1, restricted by NOT
--   EXISTS to metrics with NO in-window trusted rows. For a trusted metric
--   the thin chain therefore produces NO row, every COALESCE(trusted, thin)
--   in `vals` resolves to its first argument, and the written values are
--   byte-identical to the prior body's. For a thin-only metric the trusted
--   side is NULL and the thin values fill in; its delta columns stay NULL
--   (no trusted display_medians row -> the untouched CASEs yield NULL) —
--   no delta basis, honestly no badge.
-- * jp_display_sample_count (ADD COLUMN IF NOT EXISTS integer — the
--   20260602040000 / 20260613150000 jp_* column pattern; integer matches
--   jp_card_price_history.sample_count) = MAX sample_count among the
--   in-window rows feeding the displayed value, written for ALL displayed
--   rows: >= 3 by construction on the trusted pass, 1-2 on the thin pass,
--   NULL when nothing displays (cleared alongside the prices). Clients
--   branch on < 3.
-- * NULL sample_count rows slip NEITHER floor: both predicates read
--   coalesce(h.sample_count, 0), mapping NULL to 0 (fails >= 1). Prod
--   2026-06-12: 0 in-window canonical RAW rows have NULL sample_count.
--
-- METRIC-ROW INSERT FLOOR (>= 3 -> >= 1) — DELIBERATE
-- ---------------------------------------------------
-- The 20260613220000 INSERT mirrored the trusted bar (>= 3). Kept there, the
-- 252 thin-only slugs with no card_metrics row would stay structurally
-- invisible — the exact failure mode that migration fixed, and unlocking
-- these slugs is the point of THIS one. The INSERT therefore admits
-- sample_count >= 1: precisely the union of both tiers' qualifying bars,
-- i.e. every slug the UPDATE below can give a display price to. Survival
-- follows automatically: the refresh_card_metrics GC exemption keys on
-- jp_display_price IS NOT NULL (20260613220000), which this same invocation
-- fills for thin rows too.
--
-- VIEW TRUST GRAMMAR (EN single-source precedent, JP edition)
-- -----------------------------------------------------------
-- For JP-RAW rows displaying a thin-tier price: market_confidence_score 30
-- (the EN well-sampled PRICECHARTING_PRIMARY rate), market_low_confidence
-- true, market_price_display_state 'JP_LOW_SAMPLE', and public
-- change_pct_24h/7d hard-NULLed AHEAD of the existing coalesce fallback —
-- jp_display_change_pct_* is already NULL for thin rows, but the fallback
-- (base change from compute_jp_card_price_changes) could carry a STALE
-- delta written while the card still had a trusted series; same "MUST run
-- before the display-change fallback" ordering as the EN single-source
-- branches. Tile/rail floors (public_jp_price_coverage,
-- lib/pricing/jp-price-source.ts, iOS selectJpPriceSource) are deliberately
-- NOT touched — detail-page-first by design.
--
-- MONITORING (same PR, code side)
-- -------------------------------
-- app/api/cron/check-jp-source-divergence gains a jp-display staleness
-- alarm (max(jp_display_price_as_of) age > 48h -> fail-loud 500): the GC
-- exemption ties metric-row survival to the hourly display cron, so a dead
-- display cron must not be silent (three prior silent-fallback incidents —
-- docs/external-api-failure-modes.md).
--
-- APPLY-TIME BOUND / ROLLBACK
-- ---------------------------
-- The one-shot refresh_jp_price_display() at the end is the normal
-- unbounded full pass (~0.8-4s; see 20260613150000) plus the one-time
-- ~252-row INSERT and the thin chain over the small 14d history slice —
-- thin-tier prices and sample counts converge at apply, no
-- partial-coverage window. Rollback: re-assert the two bodies from
-- 20260613220000 / 20260613150000 (with supersedes headers); thin-tier rows
-- then clear on the next hourly tick (their vals go all-NULL under a
-- trusted-only body) and the inserted rows self-GC once jp_display_price
-- clears. jp_display_sample_count becomes inert residue (IF NOT EXISTS
-- pattern), invisible behind the jp_display_price IS NOT NULL keying.

-- ---------------------------------------------------------------------------
-- 1. Thin-tier attribution column. Sibling of the jp_* display family;
--    integer to match jp_card_price_history.sample_count.
-- ---------------------------------------------------------------------------
alter table public.card_metrics
  add column if not exists jp_display_sample_count integer;

-- ---------------------------------------------------------------------------
-- 2. refresh_jp_price_display — body VERBATIM from 20260613220000 (latest
--    prior definer) plus the declared two-tier additions in the file header.
--    Same signature, so the cron call site is untouched. The prior definer's
--    revoke is reproduced verbatim (CREATE OR REPLACE retains ACLs; kept for
--    parity).
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
  inserted_count int := 0;
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
  -- NEW (20260613220000): metric-row unlock. Create the missing canonical RAW
  -- card_metrics row for every JP slug with qualifying canonical-level RAW
  -- history so the UPDATE below has a row to write. 20260614150000 drops the
  -- floor from sample_count >= 3 (the trusted bar, `hist` below) to >= 1 (the
  -- thin tier's bar, `thin_hist` below) — the union of both display tiers'
  -- qualifying bars, i.e. exactly the slugs the UPDATE can give a display
  -- price to; kept at >= 3, thin-only slugs without metric rows (252 on
  -- prod, 2026-06-12) would stay structurally invisible. All metric
  -- columns stay NULL — honest: there is no Scrydex data, and
  -- public_card_metrics displays JP RAW rows from jp_display_price alone,
  -- which this same invocation fills. Conflict target infers
  -- card_metrics_slug_printing_grade_uidx ((canonical_slug, printing_id,
  -- grade) NULLS NOT DISTINCT), so the NULL-printing canonical row has a
  -- stable target; DO NOTHING covers concurrent refresh_card_metrics upserts.
  -- The GC exemption above keeps these rows alive while they display.
  -- p_max_cards deliberately does not bound this step: it is a defensive
  -- bound on the UPDATE scope, and this insert set is one-time ~hundreds,
  -- then incremental (new slugs as JP sources first cover them).
  insert into public.card_metrics (canonical_slug, printing_id, grade, updated_at)
  select distinct h.canonical_slug, null::uuid, 'RAW'::text, now()
  from public.jp_card_price_history h
  join public.canonical_cards cc
    on cc.slug = h.canonical_slug
   and cc.language = 'JP'
  where h.printing_id is null
    and h.grade = 'RAW'
    and h.price_usd is not null
    and h.price_usd > 0
    and coalesce(h.sample_count, 0) >= 1
    and h.observed_at >= cutoff_14d
    and not exists (
      select 1
      from public.card_metrics cm
      where cm.canonical_slug = h.canonical_slug
        and cm.printing_id is null
        and cm.grade = 'RAW'
    )
  on conflict (canonical_slug, printing_id, grade) do nothing;

  get diagnostics inserted_count = row_count;

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
      greatest(coalesce(h.sample_count, 1), 1)::numeric as wt,
      -- NEW (20260614150000): attribution only — max() of this feeds
      -- jp_display_sample_count via trusted_samples; no other consumer.
      h.sample_count
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
  -- NEW (20260614150000): trusted-pass attribution — the max in-window
  -- sample_count among the hist rows feeding the displayed value. Always
  -- >= 3 here (hist's floor), so clients branching on < 3 keep treating
  -- trusted rows as trusted.
  trusted_samples as (
    select metric_id, max(sample_count) as max_sample_count
    from hist
    group by metric_id
  ),
  -- NEW (20260614150000): THIN tier. Qualifying observations at
  -- sample_count >= 1, restricted to metrics with NO in-window trusted rows
  -- (the NOT EXISTS) — i.e. metrics the trusted pass above would leave
  -- displayless. NULL sample_count rows fail coalesce(...) >= 1, identical
  -- in shape to the trusted floor. The chain below mirrors the trusted
  -- formulas verbatim (sample-weighted daily blend -> freshest obs -> 14d
  -- median); display deltas are deliberately NOT computed from this series
  -- (1-2-sample medians are no basis for a movement claim).
  thin_hist as (
    select
      s.metric_id,
      h.observed_at,
      h.price_usd,
      greatest(coalesce(h.sample_count, 1), 1)::numeric as wt,
      h.sample_count
    from jp_scope s
    join public.jp_card_price_history h
      on h.canonical_slug = s.canonical_slug
     and h.printing_id is not distinct from s.printing_id
     and h.grade = s.grade
    where h.price_usd is not null
      and h.price_usd > 0
      and coalesce(h.sample_count, 0) >= 1
      and h.observed_at >= cutoff_14d
      and not exists (
        select 1 from hist t where t.metric_id = s.metric_id
      )
  ),
  thin_daily as (
    select
      metric_id,
      date_trunc('day', observed_at) as day_ts,
      (sum(price_usd * wt) / nullif(sum(wt), 0))::numeric as day_price
    from thin_hist
    group by metric_id, date_trunc('day', observed_at)
  ),
  thin_latest_obs as (
    select distinct on (metric_id)
      metric_id, price_usd as latest_price, observed_at as latest_as_of
    from thin_hist
    order by metric_id, observed_at desc
  ),
  thin_median_14d as (
    select
      metric_id,
      (percentile_cont(0.5) within group (order by day_price))::numeric as median_price,
      max(day_ts) as median_as_of
    from thin_daily
    group by metric_id
  ),
  -- Thin-pass attribution: max in-window sample_count is 1-2 by
  -- construction (any >= 3 row would have put the metric in the trusted
  -- pass and out of thin_hist).
  thin_samples as (
    select metric_id, max(sample_count) as max_sample_count
    from thin_hist
    group by metric_id
  ),
  vals as (
    select
      s.metric_id,
      -- Trusted-first (20260614150000): for a trusted metric the thin chain
      -- has no row at all (thin_hist's NOT EXISTS), so each coalesce
      -- resolves to its trusted argument — byte-identical to the prior
      -- body. Thin values only ever fill metrics the trusted pass left
      -- displayless.
      coalesce(lo.latest_price, tl.latest_price) as latest_price,
      coalesce(lo.latest_as_of, tl.latest_as_of) as latest_as_of,
      coalesce(m.median_price, tm.median_price) as median_price,
      coalesce(m.median_as_of, tm.median_as_of) as median_as_of,
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
      end as display_change_pct_7d,
      -- NEW (20260614150000): attribution for ALL displayed rows — trusted
      -- max is >= 3 by construction, thin max is 1-2, NULL when neither
      -- tier has in-window rows (cleared alongside the prices, same
      -- lifecycle).
      coalesce(ts.max_sample_count, tn.max_sample_count) as display_sample_count
    from jp_scope s
    left join latest_obs lo using (metric_id)
    left join median_14d m using (metric_id)
    left join display_medians dm using (metric_id)
    left join trusted_samples ts using (metric_id)
    left join thin_latest_obs tl using (metric_id)
    left join thin_median_14d tm using (metric_id)
    left join thin_samples tn using (metric_id)
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
      jp_display_change_pct_7d = v.display_change_pct_7d,
      jp_display_sample_count = v.display_sample_count
    from vals v
    where cm.id = v.metric_id
      and (
        cm.jp_latest_price is distinct from v.latest_price
        or cm.jp_latest_price_as_of is distinct from v.latest_as_of
        or cm.jp_display_price is distinct from v.median_price
        or cm.jp_display_price_as_of is distinct from v.median_as_of
        or cm.jp_display_change_pct_24h is distinct from v.display_change_pct_24h
        or cm.jp_display_change_pct_7d is distinct from v.display_change_pct_7d
        or cm.jp_display_sample_count is distinct from v.display_sample_count
      )
    returning 1
  )
  select count(*) into updated_count from do_update;

  return jsonb_build_object('jp_updated', updated_count, 'jp_rows_created', inserted_count);
end;
$$;

-- SECURITY DEFINER lockdown: writes card_metrics, so not callable by anon /
-- authenticated. The service-role cron bypasses grants.
revoke all on function public.refresh_jp_price_display(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. public_card_metrics — body VERBATIM from 20260613150000 (latest prior
--    definer) plus the declared thin-tier trust-grammar branches and ONE
--    trailing passthrough column. New columns MUST be appended last: CREATE
--    OR REPLACE VIEW only allows adding trailing columns.
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
      -- Thin-tier JP rows (max in-window sample_count < 3): deliberately NO
      -- change badge. MUST run before the display-change fallback below —
      -- jp_display_change_pct_* is already NULL for thin rows (the function
      -- computes deltas from the trusted series only), but the base
      -- change_pct_24h fallback could carry a STALE delta written while the
      -- card still had a trusted series, leaking a movement % onto a
      -- low-confidence thin-sample price (the EN single-source ordering
      -- note, JP edition).
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then null
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
      -- Thin-tier JP rows: no change badge — see the 24h note above; same
      -- ordering, ahead of the display-change fallback.
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then null
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
      -- Thin-tier JP rows: low confidence (30) — mirrors the EN well-sampled
      -- single-source PriceCharting rate above: the price is surfaced but
      -- explicitly de-rated vs the 90 of a two-source MATCH. Sits ahead of
      -- the outlier branch for the same reason the JP headline branch does:
      -- the outlier flag is about the Scrydex-basis base market_price, which
      -- the JP display path never uses. Trusted (>= 3) JP rows fall through
      -- unchanged.
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then 30
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
      -- Thin-tier JP rows are low confidence by construction (the EN
      -- single-source precedent; market_low_confidence is the view's
      -- low-confidence output flag).
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then true
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
      -- Thin-tier JP display state (the JP-RAW headline is non-null here —
      -- the NO_RELIABLE_PRICE branch above already caught null prices, and
      -- the JP-RAW headline IS jp_display_price). Mirrors
      -- PRICECHARTING_SINGLE_SOURCE's position ahead of the
      -- signal-direction/ALIGNED states; trusted JP rows keep landing in
      -- ALIGNED exactly as before.
      when g.canonical_language = 'JP' and g.grade = 'RAW'
       and g.jp_display_price is not null
       and g.jp_display_sample_count < 3
        then 'JP_LOW_SAMPLE'
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
  jp_display_change_pct_7d,
  -- Thin-tier attribution (additive; raw passthrough of the new base
  -- column). MAX in-window sample_count behind the displayed JP price:
  -- >= 3 trusted, 1-2 thin, NULL when nothing displays. Clients branch on
  -- < 3 (iOS subline lands in a separate PR).
  jp_display_sample_count
from public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. One-shot apply-time run (same pattern as 20260613150000 /
--    20260613220000): the one-time ~252-row metric-row INSERT, the thin-tier
--    prices and jp_display_sample_count for EVERY displayed row all land in
--    the same invocation — coverage and attribution converge at apply
--    instead of waiting up to an hour for the next refresh-jp-price-display
--    tick. Normal unbounded full pass (~0.8-4s) plus the small thin chain.
-- ---------------------------------------------------------------------------
select public.refresh_jp_price_display();
