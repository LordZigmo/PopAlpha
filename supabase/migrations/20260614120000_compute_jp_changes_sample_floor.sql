-- 20260614120000_compute_jp_changes_sample_floor.sql
--
-- supersedes: 20260520140000_compute_jp_card_price_changes.sql
--
-- Add a sample_count >= 3 floor to compute_jp_card_price_changes().
--
-- Why now
-- -------
-- This PR (option E of the JP display-policy design) flips the Snkrdunk
-- writers (app/api/cron/run-snkrdunk-daily/route.ts and
-- scripts/run-snkrdunk-pipeline.mjs) from MIN_SAMPLE_COUNT = 3 gating the
-- WRITE to MIN_WRITE_SAMPLE_COUNT = 1: a scrape returning 1-2 sold samples
-- per grade now persists those observations (snkrdunk_card_prices +
-- jp_card_price_history) with their true sample_count instead of
-- destroying them. The parking decision is unchanged (no grade >= 3 still
-- classifies "low-sample" and parks 30d), and the display floor lives in
-- refresh_jp_price_display, which already requires
-- coalesce(sample_count, 0) >= 3 (migration 20260613150000).
--
-- compute_jp_card_price_changes() was the remaining consumer WITHOUT a
-- floor: its recent_history CTE accepted any canonical RAW row with a
-- positive price_jpy. Without this gate, the newly-written 1-sample
-- Snkrdunk observations could (a) inflate a source's point_count and flip
-- best_source away from a trusted series, and (b) become the latest_price
-- or a baseline for the base 24h/7d deltas — a single sold listing
-- swinging the source-pure delta series. The display-basis deltas are
-- already safe (their own hist CTE floors at >= 3, migration
-- 20260613150000); this aligns the base populator with the same
-- qualifying bar.
--
-- Not just a Snkrdunk concern: Yahoo! JP has always written from
-- sample_count = 1. Measured on prod 2026-06-12, the 21d lookback window
-- held 8,281 yahoo_jp canonical RAW rows (of 15,706; 1,597 slugs) below
-- the floor — those were silently feeding the base deltas. After this
-- migration both sources' delta math reads only >= 3-sample observations.
--
-- Two changes vs the prior body (everything else verbatim):
--
--   1. recent_history CTE gains `and coalesce(h.sample_count, 0) >= 3`
--      (sample_count is nullable; null counts as 0 — same predicate as
--      refresh_jp_price_display).
--   2. The stale-wipe NOT EXISTS gains the same floor. The wipe asks
--      "does qualifying history exist in the last 14d?" — and a
--      low-sample-only 14d window can no longer produce deltas (change 1),
--      so change values surviving from older trusted data would be stale.
--      Treating low-sample-only as "no qualifying history" wipes them.
--
-- The one-shot call at the end converges existing rows immediately:
-- slugs with qualifying history get recomputed from >= 3-sample rows
-- only; slugs whose recent history is entirely sub-floor get their
-- change_pct values nulled by the (now floored) stale wipe.

create or replace function public.compute_jp_card_price_changes()
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
  -- Lookback window. Must extend past the 7d baseline upper bound
  -- (now-4d) and ideally past the 7d baseline lower bound (now-14d)
  -- so a slug whose only baseline candidate is ~10d old still
  -- qualifies. 21 days is enough headroom plus a buffer for cron lag.
  cutoff_lookback      timestamptz := now() - interval '21 days';
  -- Recency gates on the latest observation, separate per window:
  -- a 24h delta only makes sense if "now" really is recent (≤3d);
  -- a 7d delta is meaningful as long as the card is in-rail (≤14d,
  -- looser than the rail's 7d freshness threshold so we don't drop
  -- cards that the rail would still display).
  cutoff_24h_latest    timestamptz := now() - interval '72 hours';
  cutoff_7d_latest     timestamptz := now() - interval '14 days';
  -- Stale-wipe threshold for the NULL branch — see the design comment
  -- above. 14d is the same window the 7d baseline upper bound implies
  -- (no history newer than 14d → no 7d baseline is computable either).
  cutoff_stale_wipe    timestamptz := now() - interval '14 days';
  -- Time-anchored baseline windows, widened for JP write cadence.
  -- See the "Window cadence" design note in migration 20260520140000.
  baseline_24h_lo      timestamptz := now() - interval '72 hours';
  baseline_24h_hi      timestamptz := now() - interval '12 hours';
  baseline_7d_lo       timestamptz := now() - interval '14 days';
  baseline_7d_hi       timestamptz := now() - interval '4 days';
  outlier_cap_pct      numeric     := 200;
begin
  with recent_history as (
    -- Lookback window covers both the 24h and 7d baselines plus the
    -- current observation. Filter to canonical-level RAW rows (the
    -- target scope on card_metrics) and require price_jpy to be set
    -- so the ratio is computed in a single currency end-to-end.
    select
      h.canonical_slug,
      h.source,
      h.recorded_at,
      h.price_jpy
    from public.jp_card_price_history h
    join public.canonical_cards cc on cc.slug = h.canonical_slug
    where cc.language = 'JP'
      and h.grade = 'RAW'
      and h.printing_id is null
      and h.recorded_at >= cutoff_lookback
      and h.price_jpy is not null
      and h.price_jpy > 0
      -- Sample floor (20260614120000): the JP writers persist 1-2-sample
      -- observations (Yahoo always has; Snkrdunk does as of the same PR),
      -- but a single sold listing must not flip best_source or anchor a
      -- delta. Same qualifying bar as refresh_jp_price_display
      -- (migration 20260613150000). sample_count is nullable → null
      -- counts as 0 and is excluded.
      and coalesce(h.sample_count, 0) >= 3
  ),
  source_stats as (
    select
      canonical_slug,
      source,
      count(*) as point_count,
      max(recorded_at) as latest_ts
    from recent_history
    group by canonical_slug, source
  ),
  best_source as (
    -- Pick one source per slug so the delta math doesn't compare
    -- across sources. Tie-break on most recent latest_ts so newer
    -- coverage wins when both have equal counts.
    select distinct on (canonical_slug)
      canonical_slug,
      source
    from source_stats
    order by canonical_slug, point_count desc, latest_ts desc nulls last
  ),
  latest_price as (
    select distinct on (h.canonical_slug)
      h.canonical_slug,
      h.price_jpy as price_now,
      h.recorded_at as latest_ts
    from recent_history h
    join best_source bs using (canonical_slug, source)
    order by h.canonical_slug, h.recorded_at desc
  ),
  -- Time-anchored 24h baseline.
  price_at_24h as (
    select distinct on (h.canonical_slug)
      h.canonical_slug,
      h.price_jpy as price_24h,
      h.recorded_at as price_24h_ts
    from recent_history h
    join best_source bs using (canonical_slug, source)
    where h.recorded_at between baseline_24h_lo and baseline_24h_hi
    order by h.canonical_slug, h.recorded_at desc
  ),
  -- Time-anchored 7d baseline.
  price_at_7d as (
    select distinct on (h.canonical_slug)
      h.canonical_slug,
      h.price_jpy as price_7d,
      h.recorded_at as price_7d_ts
    from recent_history h
    join best_source bs using (canonical_slug, source)
    where h.recorded_at between baseline_7d_lo and baseline_7d_hi
    order by h.canonical_slug, h.recorded_at desc
  ),
  changes as (
    select
      lp.canonical_slug,
      lp.price_now,
      lp.latest_ts,
      case
        when p24.price_24h is not null
         and p24.price_24h > 0
         and lp.latest_ts > cutoff_24h_latest
         and abs(((lp.price_now - p24.price_24h) / p24.price_24h) * 100) <= outlier_cap_pct
        then ((lp.price_now - p24.price_24h) / p24.price_24h) * 100
        else null
      end as change_pct_24h,
      case
        when p7.price_7d is not null
         and p7.price_7d > 0
         and lp.latest_ts > cutoff_7d_latest
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
      change_pct_24h = c.change_pct_24h,
      change_pct_7d  = c.change_pct_7d
    from changes c
    where cm.canonical_slug = c.canonical_slug
      and cm.printing_id is null
      and cm.grade = 'RAW'
      and (
        cm.change_pct_24h is distinct from c.change_pct_24h
        or cm.change_pct_7d is distinct from c.change_pct_7d
      )
    returning cm.id
  )
  select count(*) into updated_count from do_update;

  -- NULL branch — see the "JP-specific design choices" comment block in
  -- migration 20260520140000. Wipe change_pct values for JP rows where no
  -- qualifying history row exists in the last 14 days. Guards against a
  -- sustained history-write outage stranding stale momentum data while the
  -- rail's market_price stays fresh via the latest-price tables.
  --
  -- The do_update set above and this do_null set are disjoint by
  -- construction: a slug with no history in the last 14d cannot have
  -- produced a row in `changes` (the lookback already requires
  -- recorded_at >= now-21d, but more importantly, the baseline windows
  -- and recency gates above don't accept anything older than 14d).
  with stale_jp as (
    select cm.id
    from public.card_metrics cm
    join public.canonical_cards cc on cc.slug = cm.canonical_slug
    where cc.language = 'JP'
      and cm.printing_id is null
      and cm.grade = 'RAW'
      and (cm.change_pct_24h is not null or cm.change_pct_7d is not null)
      and not exists (
        select 1
        from public.jp_card_price_history h
        where h.canonical_slug = cm.canonical_slug
          and h.grade = 'RAW'
          and h.printing_id is null
          and h.price_jpy is not null
          and h.price_jpy > 0
          -- Sample floor (20260614120000), matching recent_history above:
          -- "qualifying history" means rows the delta math can actually
          -- use. If the only 14d history is sub-floor rows, the deltas
          -- cannot be recomputed from them, so change values surviving
          -- from older trusted data are stale → treat low-sample-only
          -- as "no qualifying history" and wipe.
          and coalesce(h.sample_count, 0) >= 3
          and h.recorded_at >= cutoff_stale_wipe
      )
  ),
  do_null as (
    update public.card_metrics cm
    set
      change_pct_24h = null,
      change_pct_7d  = null
    from stale_jp s
    where cm.id = s.id
    returning cm.id
  )
  select count(*) into nulled_count from do_null;

  return jsonb_build_object(
    'updated', updated_count,
    'nulled',  nulled_count,
    'baseline_24h_window', jsonb_build_array(baseline_24h_lo, baseline_24h_hi),
    'baseline_7d_window', jsonb_build_array(baseline_7d_lo, baseline_7d_hi),
    'cutoff_24h_latest', cutoff_24h_latest,
    'cutoff_7d_latest', cutoff_7d_latest,
    'cutoff_stale_wipe', cutoff_stale_wipe,
    'outlier_cap_pct', outlier_cap_pct
  );
end;
$$;

comment on function public.compute_jp_card_price_changes() is
  'Populates card_metrics.change_pct_24h / change_pct_7d for JP-language '
  'canonical-level RAW rows by reading jp_card_price_history. Mirrors '
  'refresh_price_changes() (migration 20260501010000) with windows '
  'widened for the JP cron cadence (weekly per-slug refresh): 24h '
  'baseline in [now-72h, now-12h], 7d baseline in [now-14d, now-4d]. '
  '±200% outlier cap, recency gates on the latest observation, NULL '
  'branch wipes change_pct when no qualifying history exists in the '
  'last 14 days (guards against history-write outages). Per-slug '
  'source selection prefers the source with the most history points '
  'in the lookback window so the delta math stays within a single '
  'source. Qualifying history requires coalesce(sample_count, 0) >= 3 '
  '(migration 20260614120000) — the JP writers persist 1-2-sample '
  'observations, but only >= 3-sample rows may pick best_source, anchor '
  'a baseline, or count as fresh for the stale wipe.';

-- Re-assert the execute contract established for this function in
-- 20260522213801_harden_public_function_execute_contract.sql (cron-only
-- helper, never a direct public RPC). create or replace preserves the
-- existing ACL, so this is belt-and-braces against drift.
revoke execute on function public.compute_jp_card_price_changes() from public, anon, authenticated;
grant execute on function public.compute_jp_card_price_changes() to service_role;

-- One-shot run so the floor takes effect at apply time: recomputes deltas
-- from qualifying (>= 3-sample) rows and wipes deltas whose only recent
-- support was sub-floor rows, instead of waiting for the next
-- refresh-card-metrics tick (12h cadence).
select public.compute_jp_card_price_changes();
