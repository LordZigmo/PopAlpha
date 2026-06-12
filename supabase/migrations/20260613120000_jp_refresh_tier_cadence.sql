-- 20260613120000_jp_refresh_tier_cadence.sql
--
-- JP refresh_tier: tiered scrape cadence for Snkrdunk + Yahoo! JP so hot JP
-- cards get a fresh observation daily — making true 24h price-change pairs
-- possible. (Roadmap "PR 3" in docs/jp-coverage-roadmap.md.)
--
-- Why
-- ---
-- compute_jp_card_price_changes (20260520140000) needs a history row <72h old
-- plus a baseline in [now-72h, now-12h] for a 24h delta. Both JP crons refresh
-- a card only when its observed_at is older than a FLAT 7 days, so almost no
-- JP slug ever has a 24h pair (measured 2026-06-12: of 5,349 slugs with recent
-- history, 13 had a fresh-latest pair; 2,887 of 3,025 non-null 24h values were
-- the degenerate 0%). The writer-partition fix (20260612014500) made the
-- change columns JP-native; cadence is the remaining lever.
--
-- Why a SEPARATE jp_refresh_tier column (not the EN refresh_tier)
-- ---------------------------------------------------------------
-- canonical_cards.refresh_tier is computed weekly by compute_refresh_tier()
-- from SCRYDEX observation matches — for JP cards it reflects Scrydex's thin
-- JP feed (hot 0 / warm 7 / sparse 14,952 / dormant 5,750 measured), not
-- Snkrdunk/Yahoo activity, and the weekly EN recompute would clobber any
-- JP-native values written into the shared column. That column also feeds
-- compute_daily_top_movers' warm-pop auto-threshold, the Scrydex dormant-set
-- fetch planner (lib/backfill/scrydex-price-history.ts), and the public /data
-- tier summary — three EN systems this migration must not perturb. Same
-- vocabulary, sibling column, recomputed from the same weekly cron route.
--
-- Tier assignment (compute_jp_refresh_tier)
-- -----------------------------------------
-- liquidity_score := greatest(snkrdunk max sample_count, 2 x yahoo max
-- sample_count) over RAW rows — the x2 normalizes 1-page Yahoo scrapes vs
-- 4-page Snkrdunk scrapes (tuning knob, mirrored in
-- lib/jp/refresh-cadence.mjs). Open thresholds cannot bound the hot
-- population, so hot is a RANK CAP — capacity-safe by construction:
--
--   hot     viewed in 30d (force-include) OR score >= 10 AND rank <= 500
--   warm    score >= 4 AND rank <= 2000 (hot cap + 1,500)
--   sparse  priced by either source
--   dormant JP card with no price row from either source
--   unknown never classified — scan RPCs treat it as sparse cadence
--           (168h = exactly today's flat behavior, fail-open)
--
-- Dry-run on prod 2026-06-12: hot = 577 (327 Snkrdunk-priced, 250
-- Yahoo-only). Movement-based promotion is deferred until daily cadence
-- exists to measure movement against.
--
-- Cadence matrix (scan_*_refresh_candidates) and capacity arithmetic
-- ------------------------------------------------------------------
-- Observed throughput (7d avg of jp_ingestion_runs): ~984 processed/day per
-- source vs 1,200 theoretical (50/tick hourly, 4s politeness delay — the
-- politeness constants are a hard constraint and are NOT touched).
--
--   SNKRDUNK  hot 24h (327/day) + warm 72h (~277/day) + sparse 168h
--             (~109/day) ≈ 713/day refresh + initial path ≈ fits ~984
--             observed with headroom post-backfill-drain.
--   YAHOO_JP  hot-Yahoo-only 24h (250/day) + hot-snk-covered 96h (Snkrdunk
--             owns their daily series, ~48/day) + warm 96h (~275/day) +
--             sparse 288h (~274/day) ≈ 847/day — funded by the route's
--             NONPRODUCTIVE_RETRY_HOURS 7d->30d + budget-ratio 0.6->0.75
--             change in the same PR. Sparse 288h (12d) stays inside the
--             14-day jp_display_price median window (20260602040000), so a
--             sparse card's hero price cannot age out between refreshes.
--
-- Ordering: candidates past their tier cutoff, by OVERDUE RATIO
-- ((now - observed_at) / tier_cadence) DESC, NULLs first. Under temporary
-- capacity shortfall every tier drifts proportionally instead of the sparse
-- tail starving (a hot card 2h overdue outranks a sparse card 4h overdue,
-- but not one 4 days overdue).
--
-- All four functions are NEW (no prior definer), so no `-- supersedes:`
-- header is required by check:migrations:fnbody. SECURITY DEFINER + lockdown
-- mirrors 20260602080000 / 20260506010000. One-shot apply call at the end so
-- tiers exist the moment the cron routes start asking for them.

-- =============================================================================
-- 1. Column + indexes (mirrors 20260506010000_canonical_cards_refresh_tier)
-- =============================================================================

alter table public.canonical_cards
  add column if not exists jp_refresh_tier text not null default 'unknown',
  add column if not exists jp_refresh_tier_computed_at timestamptz;

alter table public.canonical_cards
  drop constraint if exists canonical_cards_jp_refresh_tier_check;
alter table public.canonical_cards
  add constraint canonical_cards_jp_refresh_tier_check
  check (jp_refresh_tier in ('unknown', 'hot', 'warm', 'sparse', 'dormant'));

-- The scan RPCs read the tier per candidate row via the canonical_cards PK
-- join, so a dedicated tier index isn't on their path; this one serves the
-- weekly recompute's transition diff + ad-hoc distribution queries.
create index if not exists canonical_cards_jp_refresh_tier_idx
  on public.canonical_cards (jp_refresh_tier);

-- =============================================================================
-- 2. compute_jp_refresh_tier() — recommendation per JP canonical card
-- =============================================================================

create or replace function public.compute_jp_refresh_tier()
returns table (
  canonical_slug text,
  liquidity_score numeric,
  viewed_30d boolean,
  recommended_tier text
)
language sql
stable
security definer
set statement_timeout to '60s'
set search_path to 'public'
as $$
  with snk as (
    select p.canonical_slug, max(p.sample_count) as snk_sample
    from public.snkrdunk_card_prices p
    where p.grade = 'RAW'
    group by p.canonical_slug
  ),
  yah as (
    select y.canonical_slug, max(y.sample_count) as yah_sample
    from public.yahoo_jp_card_prices y
    where y.grade = 'RAW'
    group by y.canonical_slug
  ),
  viewed as (
    select distinct v.canonical_slug
    from public.card_page_views v
    where v.viewed_at >= now() - interval '30 days'
  ),
  scored as (
    select
      cc.slug as canonical_slug,
      greatest(coalesce(s.snk_sample, 0), 2 * coalesce(y.yah_sample, 0))::numeric as liquidity_score,
      (v.canonical_slug is not null) as viewed_30d,
      (s.canonical_slug is not null or y.canonical_slug is not null) as priced
    from public.canonical_cards cc
    left join snk s on s.canonical_slug = cc.slug
    left join yah y on y.canonical_slug = cc.slug
    left join viewed v on v.canonical_slug = cc.slug
    where cc.language = 'JP'
  ),
  ranked as (
    select
      scored.*,
      row_number() over (order by scored.liquidity_score desc, scored.canonical_slug) as liquidity_rank
    from scored
  )
  select
    r.canonical_slug,
    r.liquidity_score,
    r.viewed_30d,
    case
      -- Force-include viewed cards: demand beats liquidity rank. An unpriced
      -- viewed card is harmlessly hot — the scan RPCs select from the price
      -- tables, so it cannot consume refresh slots until it gains a price row
      -- (the initial-coverage path owns unpriced cards).
      when r.viewed_30d or (r.liquidity_score >= 10 and r.liquidity_rank <= 500) then 'hot'
      when r.liquidity_score >= 4 and r.liquidity_rank <= 2000 then 'warm'
      when r.priced then 'sparse'
      else 'dormant'
    end as recommended_tier
  from ranked r;
$$;

revoke all on function public.compute_jp_refresh_tier() from public, anon, authenticated;
grant execute on function public.compute_jp_refresh_tier() to service_role;

-- =============================================================================
-- 3. apply_jp_refresh_tier_recompute() — the weekly cron's entry point
--    (called from app/api/cron/recompute-refresh-tier alongside the EN apply)
-- =============================================================================

create or replace function public.apply_jp_refresh_tier_recompute()
returns jsonb
language plpgsql
security definer
set statement_timeout to '300s'
set search_path to 'public'
as $$
declare
  _transitions int := 0;
  _hot int;
  _warm int;
  _sparse int;
  _dormant int;
  _unknown int;
begin
  with recommended as (
    select * from public.compute_jp_refresh_tier()
  ),
  changed as (
    update public.canonical_cards cc
    set
      jp_refresh_tier = r.recommended_tier,
      jp_refresh_tier_computed_at = now()
    from recommended r
    where cc.slug = r.canonical_slug
      and cc.jp_refresh_tier is distinct from r.recommended_tier
    returning 1
  )
  select count(*) into _transitions from changed;

  -- Stamp untouched JP rows so we can tell "recompute ran, no transition"
  -- from "never classified" (mirrors apply_refresh_tier_recompute).
  update public.canonical_cards
    set jp_refresh_tier_computed_at = now()
    where language = 'JP' and jp_refresh_tier_computed_at is null;

  select
    count(*) filter (where jp_refresh_tier = 'hot'),
    count(*) filter (where jp_refresh_tier = 'warm'),
    count(*) filter (where jp_refresh_tier = 'sparse'),
    count(*) filter (where jp_refresh_tier = 'dormant'),
    count(*) filter (where jp_refresh_tier = 'unknown')
  into _hot, _warm, _sparse, _dormant, _unknown
  from public.canonical_cards
  where language = 'JP';

  return jsonb_build_object(
    'computed_at', now(),
    'transitions', _transitions,
    'distribution', jsonb_build_object(
      'hot', coalesce(_hot, 0),
      'warm', coalesce(_warm, 0),
      'sparse', coalesce(_sparse, 0),
      'dormant', coalesce(_dormant, 0),
      'unknown', coalesce(_unknown, 0)
    )
  );
end;
$$;

revoke all on function public.apply_jp_refresh_tier_recompute() from public, anon, authenticated;
grant execute on function public.apply_jp_refresh_tier_recompute() to service_role;

-- =============================================================================
-- 4. scan_snkrdunk_refresh_candidates — tier-cadence stale scan
--    Replaces run-snkrdunk-daily's client-side paging loop (flat 168h cutoff).
--    Same dedupe-by-product-code with the per-printing row preferred (Codex P2
--    on PR #50: the per-printing candidate refreshes BOTH the per-printing and
--    canonical rows in one pass; the canonical candidate strands the
--    per-printing row stale).
-- =============================================================================

create or replace function public.scan_snkrdunk_refresh_candidates(
  p_limit int,
  p_suppressed text[] default '{}'
)
returns table (
  canonical_slug text,
  printing_id uuid,
  snkrdunk_product_code text,
  observed_at timestamptz,
  tier text
)
language sql
stable
security definer
set search_path = public
as $$
  with cadenced as (
    select
      p.canonical_slug,
      p.printing_id,
      p.snkrdunk_product_code,
      p.observed_at,
      coalesce(cc.jp_refresh_tier, 'unknown') as tier,
      -- Mirrored in lib/jp/refresh-cadence.mjs (JP_TIER_CADENCE_HOURS.snkrdunk);
      -- keep the two in sync.
      case coalesce(cc.jp_refresh_tier, 'unknown')
        when 'hot' then interval '24 hours'
        when 'warm' then interval '72 hours'
        when 'dormant' then interval '720 hours'
        else interval '168 hours' -- sparse + unknown = today's flat behavior
      end as refresh_after
    from public.snkrdunk_card_prices p
    join public.canonical_cards cc on cc.slug = p.canonical_slug
    where p.snkrdunk_product_code is not null
      and not (p.snkrdunk_product_code = any(p_suppressed))
  ),
  due as (
    select *
    from cadenced c
    where c.observed_at is null or c.observed_at < now() - c.refresh_after
  ),
  deduped as (
    select distinct on (d.snkrdunk_product_code) d.*
    from due d
    order by d.snkrdunk_product_code, (d.printing_id is not null) desc, d.observed_at asc nulls first
  )
  select
    d.canonical_slug,
    d.printing_id,
    d.snkrdunk_product_code,
    d.observed_at,
    d.tier
  from deduped d
  order by
    (d.observed_at is null) desc,
    (extract(epoch from (now() - d.observed_at)) / nullif(extract(epoch from d.refresh_after), 0)) desc nulls last
  limit greatest(p_limit, 0);
$$;

revoke all on function public.scan_snkrdunk_refresh_candidates(int, text[]) from public, anon, authenticated;
grant execute on function public.scan_snkrdunk_refresh_candidates(int, text[]) to service_role;

-- =============================================================================
-- 5. scan_yahoo_refresh_candidates — tier-cadence stale scan
--    Replaces run-yahoo-jp-daily's loadStaleYahooSlugs paging loop. Hot cards
--    already covered by a CANONICAL RAW Snkrdunk price refresh at 96h here
--    (Snkrdunk owns their daily RAW series — double-scraping the same card
--    daily on both sources would waste ~190 Yahoo slots/day); Yahoo-only hot
--    cards get 24h.
-- =============================================================================

create or replace function public.scan_yahoo_refresh_candidates(
  p_limit int,
  p_suppressed text[] default '{}'
)
returns table (
  canonical_slug text,
  observed_at timestamptz,
  tier text
)
language sql
stable
security definer
set search_path = public
as $$
  with cadenced as (
    select
      y.canonical_slug,
      y.observed_at,
      coalesce(cc.jp_refresh_tier, 'unknown') as tier,
      -- Mirrored in lib/jp/refresh-cadence.mjs (JP_TIER_CADENCE_HOURS.yahoo_jp);
      -- keep the two in sync. Sparse 288h (12d) must stay inside the 14-day
      -- jp_display_price median window (20260602040000) or sparse heroes
      -- flicker null between refreshes.
      case coalesce(cc.jp_refresh_tier, 'unknown')
        when 'hot' then
          case
            -- "Snkrdunk owns the daily series" must mean the CANONICAL RAW
            -- row specifically — compute_jp_card_price_changes consumes only
            -- canonical-level RAW history, so a graded- or per-printing-only
            -- Snkrdunk presence cannot form 24h pairs and must not throttle
            -- Yahoo's RAW cadence (Codex P2 on this PR).
            when exists (
              select 1
              from public.snkrdunk_card_prices sp
              where sp.canonical_slug = y.canonical_slug
                and sp.grade = 'RAW'
                and sp.printing_id is null
                and sp.price_usd is not null
            )
            then interval '96 hours'
            else interval '24 hours'
          end
        when 'warm' then interval '96 hours'
        when 'sparse' then interval '288 hours'
        when 'dormant' then interval '720 hours'
        else interval '168 hours' -- unknown = today's flat behavior
      end as refresh_after
    from public.yahoo_jp_card_prices y
    join public.canonical_cards cc on cc.slug = y.canonical_slug
    where y.grade = 'RAW'
      and not (y.canonical_slug = any(p_suppressed))
  ),
  due as (
    select *
    from cadenced c
    where c.observed_at is null or c.observed_at < now() - c.refresh_after
  ),
  deduped as (
    select distinct on (d.canonical_slug) d.*
    from due d
    order by d.canonical_slug, d.observed_at asc nulls first
  )
  select
    d.canonical_slug,
    d.observed_at,
    d.tier
  from deduped d
  order by
    (d.observed_at is null) desc,
    (extract(epoch from (now() - d.observed_at)) / nullif(extract(epoch from d.refresh_after), 0)) desc nulls last
  limit greatest(p_limit, 0);
$$;

revoke all on function public.scan_yahoo_refresh_candidates(int, text[]) from public, anon, authenticated;
grant execute on function public.scan_yahoo_refresh_candidates(int, text[]) to service_role;

-- =============================================================================
-- 6. One-shot classification so tiers exist the moment the cron routes start
--    selecting by them. Bounded: aggregates over ~10k snkrdunk + ~16k yahoo
--    rows, updates <= ~20.7k JP canonical_cards rows once. Idempotent.
-- =============================================================================

select public.apply_jp_refresh_tier_recompute();
