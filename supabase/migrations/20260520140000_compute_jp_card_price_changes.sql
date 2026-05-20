-- 20260520140000_compute_jp_card_price_changes.sql
--
-- JP-native change_pct_24h / change_pct_7d populator for card_metrics.
--
-- Background
-- ----------
-- The five JP signal-board rails in lib/data/homepage.ts (top movers,
-- biggest drops, momentum, mid, budget) gate their candidates on
-- card_metrics.change_pct_24h / change_pct_7d being non-null. The EN
-- populator refresh_price_changes() (migration 20260501010000) only
-- reads price_history_points filtered to provider='JUSTTCG', so it
-- never produces deltas for JP-only slugs and the JP rails render
-- empty.
--
-- Migration 20260516190625_jp_card_price_history.sql created the
-- jp_card_price_history table and its own comments named this
-- follow-on explicitly:
--
--   "A follow-on migration adds compute_jp_card_price_changes() which
--    reads this table to derive change_pct_24h_jp / change_pct_7d_jp;
--    once that ships, the JP signal-board rails (lib/data/homepage.ts
--    JpRailBundle) swap their data source from Scrydex's reflection
--    to the JP-native deltas computed here."
--
-- This migration is the follow-on. Two paired changes ship alongside
-- in the same PR:
--
--   1. app/api/cron/run-yahoo-jp-daily/route.ts and
--      app/api/cron/run-snkrdunk-daily/route.ts append a row to
--      jp_card_price_history on every successful price-table upsert
--      (the orchestrator .mjs scripts already do this; the inlined
--      cron-route processCard helpers were missing it, which is why
--      the table currently has 0 rows even though the schema has
--      existed since 2026-05-16).
--   2. app/api/cron/refresh-card-metrics/route.ts calls
--      compute_jp_card_price_changes() alongside the existing
--      refresh_price_changes() call, so the JP populator runs on the
--      same 12-hourly cadence as the EN populator.
--
-- Design
-- ------
-- Mirrors refresh_price_changes() (the EN baseline at migration
-- 20260501010000) wherever the schemas line up:
--
--   * Time-anchored baselines (windows widened for JP cadence — see
--     "Window cadence" note below).
--   * Outlier cap: |change_pct| <= 200%. Suppresses to NULL rather
--     than letting an implausible value through.
--   * Recency gate on the latest observation, so a stale "current"
--     can't be paired with an even staler baseline.
--   * IS DISTINCT FROM guard on the UPDATE so unchanged rows don't
--     churn updated_at.
--   * NULL branch wipes stale change_pct values for JP rows whose
--     history has gone cold (>14d since last append).
--
-- Window cadence (P1 from Codex review on PR #113):
--   The JP cron writers refresh a slug only when its observed_at is
--   older than REFRESH_AFTER_HOURS = 7d (see run-yahoo-jp-daily.ts
--   and run-snkrdunk-daily.ts). Per-slug history append cadence is
--   therefore weekly-ish, not daily, so EN's tight ±6h / ±1d windows
--   would almost never match a JP slug's history rows.
--
--   The JP windows below are widened to fit the actual cadence:
--     change_pct_24h: baseline in [now-72h, now-12h], latest within
--                     72h. Catches "yesterday-ish" even if a write
--                     was skipped, but bounds the span at 3 days so
--                     the "24h" label stays roughly honest.
--     change_pct_7d:  baseline in [now-14d, now-4d], latest within
--                     14d. Catches the typical weekly write even if
--                     it lands a few days off the ideal anchor.
--
--   Trade-off: change_pct_24h will still be sparse on JP (only slugs
--   refreshed within the past ~3 days qualify). That's acceptable —
--   the JP rail's 24H tabs filling thinly is much better than the
--   current 0/5 rails populated state. The mid/budget rails already
--   fall back to 7D when a card lacks a 24H value (see
--   lib/data/homepage.ts JpRailBundle).
--
-- JP-specific design choices:
--
--   * Source selection. A card can have time series from yahoo_jp
--     and snkrdunk simultaneously. We pick the source with the most
--     points in the lookback window per slug (tie-break: most recent
--     latest_ts), so the delta math compares within a single source.
--     Mixing sources would corrupt the ratio when their price levels
--     differ (e.g. snkrdunk medians cluster slightly above yahoo).
--   * Currency. price_jpy is the consistent column across both
--     sources (yahoo_jp's is native scraped JPY; snkrdunk's is
--     FX-derived but stable per-row via fx_rate_used). Computing the
--     ratio in JPY removes the FX-drift noise that price_usd carries.
--     Old pre-JPY snkrdunk rows (price_jpy IS NULL) are excluded; the
--     2026-05-16 backfill stamped JPY on all existing rows so this
--     filter is informational, not exclusionary, in practice.
--   * Scope. printing_id IS NULL and grade='RAW' only — same scope as
--     the EN populator and the JP rail loader's read query. Per-
--     printing rows in jp_card_price_history exist for HOLO / Reverse
--     Holo etc. but the homepage rail reads canonical-level metrics,
--     so per-printing deltas would never reach the UI.
--   * NULL branch (P2 from Codex review on PR #113). Both JP cron
--     writers treat jp_card_price_history insert failures as non-
--     fatal warnings — so a sustained history-write outage would
--     leave market_price/market_price_as_of fresh (via the latest-
--     price tables) while old change_pct values rot indefinitely.
--     The wipe branch below clears change_pct_24h and change_pct_7d
--     when no qualifying history row exists in the last 14 days.
--     Scoped to JP rows that actually have change_pct set so we
--     don't churn ~20k JP card_metrics rows every tick.
--
-- Freshness rollout
-- -----------------
-- The history table was empty at deploy time (0 rows). After this PR
-- ships:
--
--   T0       cron writers start appending history rows hourly
--   T0+12h   the 24h baseline window [now-72h, now-12h] starts
--            containing rows → change_pct_24h begins populating on
--            the next refresh-card-metrics tick (every 12h) for
--            slugs that get touched
--   T0+4d    the 7d baseline window [now-14d, now-4d] starts
--            containing rows → change_pct_7d begins populating
--
-- In the meantime the same-day rescue (PR #112) keeps the legacy
-- .japanese rail rendered so JP users still see cards. Once
-- change_pct_24h / change_pct_7d are populated the five JP signal
-- rails fill from card_metrics naturally, no client-side change
-- required.
--
-- The migration calls the function once at apply time so any rows
-- already in jp_card_price_history (e.g. from manual .mjs script
-- runs) produce immediate deltas without waiting for the next cron
-- tick.

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
  -- See the "Window cadence" design note above.
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

  -- NULL branch — see the "JP-specific design choices" comment block
  -- above. Wipe change_pct values for JP rows where no qualifying
  -- history row exists in the last 14 days. Guards against a sustained
  -- history-write outage stranding stale momentum data while the rail's
  -- market_price stays fresh via the latest-price tables.
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
  'source.';

-- One-shot run so any rows already present in jp_card_price_history
-- (from manual .mjs orchestrator runs prior to this PR) produce
-- immediate deltas. No-op when the table is empty, which is the
-- expected state at apply time.
select public.compute_jp_card_price_changes();
