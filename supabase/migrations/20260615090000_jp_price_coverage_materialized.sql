-- supersedes: 20260604170000_drop_justtcg_price_column.sql
--
-- public_jp_price_coverage: view → MATERIALIZED view (same name, same body,
-- same grants — zero consumer changes).
--
-- Why: the plain view never pushed canonical_slug predicates into its
-- subquery — EXPLAIN ANALYZE on prod (2026-06-12) showed every per-slug
-- lookup materializing the full ~20.7k-row view (~1.2s) through the
-- public_card_metrics CTE stack before filtering. Search paid this up to
-- 5× per query (2.5-8s searches), and under evening load chunks crossed
-- the DB statement timeout → intermittent /api/search/cards 500s plus
-- homepage-cron cancels. Restructuring for pushdown means reworking
-- public_card_metrics (the most load-bearing view in the app) — too much
-- blast radius. The underlying data only changes on cron cadence (yahoo
-- :26, snkrdunk :36, refresh-jp-price-display :40 hourly), so a
-- materialized snapshot refreshed by that same hourly cron is
-- semantics-preserving: the body contains no volatile functions (verified
-- — no now()/current_*), and max staleness ≈ the cadence the data already
-- had.
--
-- Refresh: refresh_jp_price_coverage() below, called by the
-- refresh-jp-price-display cron right after the display writer runs.
-- Plain (non-CONCURRENT) refresh — CONCURRENTLY cannot run inside a
-- function/transaction — so readers see a ~1-2.5s exclusive-lock window
-- once per hour at :40; /api/search/cards fail-softs through it (PR #268).
-- Body below is verbatim pg_get_viewdef() from prod at migration time.

-- Re-run-safe drop: `drop view if exists` raises 42809 ("is not a
-- view") once the object is already a matview — IF EXISTS covers
-- nonexistence, not wrong relkind. Branch on the actual relkind so a
-- repair/re-apply (a real scenario in this repo's drift history) works
-- from either state.
do $$
declare
  kind char;
begin
  select c.relkind into kind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_jp_price_coverage';

  if kind = 'v' then
    execute 'drop view public.public_jp_price_coverage';
  elsif kind = 'm' then
    execute 'drop materialized view public.public_jp_price_coverage';
  end if;
end
$$;

create materialized view public.public_jp_price_coverage as
 WITH base AS (
         SELECT cc.slug AS canonical_slug,
            cc.canonical_name,
            cc.set_name,
            cc.year,
            cc.card_number,
            cc.primary_image_url,
            cc.mirrored_primary_image_url,
            cc.mirrored_primary_thumb_url,
            'RAW'::text AS grade,
            pcm.market_price,
            pcm.market_price_as_of,
            pcm.market_confidence_score,
            pcm.market_low_confidence,
            pcm.active_listings_7d,
            pcm.snapshot_count_30d,
            pcm.change_pct_24h,
            pcm.change_pct_7d,
            pcm.jp_latest_price,
            pcm.jp_latest_price_as_of,
            yjp.price_usd AS yahoo_jp_price,
            yjp.price_jpy AS yahoo_jp_price_jpy,
            yjp.sample_count AS yahoo_jp_sample_count,
            yjp.observed_at AS yahoo_jp_observed_at,
            snk.price_usd AS snkrdunk_price,
            snk.price_jpy AS snkrdunk_price_jpy,
            snk.sample_count AS snkrdunk_sample_count,
            snk.observed_at AS snkrdunk_observed_at,
            snk.snkrdunk_product_code
           FROM canonical_cards cc
             LEFT JOIN public_card_metrics pcm ON pcm.canonical_slug = cc.slug AND pcm.printing_id IS NULL AND pcm.grade = 'RAW'::text
             LEFT JOIN yahoo_jp_card_prices yjp ON yjp.canonical_slug = cc.slug AND yjp.printing_id IS NULL AND yjp.grade = 'RAW'::text
             LEFT JOIN snkrdunk_card_prices snk ON snk.canonical_slug = cc.slug AND snk.printing_id IS NULL AND snk.grade = 'RAW'::text
          WHERE cc.language = 'JP'::text
        ), qualified AS (
         SELECT base.canonical_slug,
            base.canonical_name,
            base.set_name,
            base.year,
            base.card_number,
            base.primary_image_url,
            base.mirrored_primary_image_url,
            base.mirrored_primary_thumb_url,
            base.grade,
            base.market_price,
            base.market_price_as_of,
            base.market_confidence_score,
            base.market_low_confidence,
            base.active_listings_7d,
            base.snapshot_count_30d,
            base.change_pct_24h,
            base.change_pct_7d,
            base.jp_latest_price,
            base.jp_latest_price_as_of,
            base.yahoo_jp_price,
            base.yahoo_jp_price_jpy,
            base.yahoo_jp_sample_count,
            base.yahoo_jp_observed_at,
            base.snkrdunk_price,
            base.snkrdunk_price_jpy,
            base.snkrdunk_sample_count,
            base.snkrdunk_observed_at,
            base.snkrdunk_product_code,
            base.market_price IS NOT NULL AND base.market_price > 0::numeric AS has_market_price,
            base.yahoo_jp_price IS NOT NULL AND base.yahoo_jp_price > 0::numeric AND COALESCE(base.yahoo_jp_sample_count, 0) >= 3 AS yahoo_jp_qualified,
            base.snkrdunk_price IS NOT NULL AND base.snkrdunk_price > 0::numeric AND COALESCE(base.snkrdunk_sample_count, 0) >= 3 AS snkrdunk_qualified
           FROM base
        ), picked AS (
         SELECT qualified.canonical_slug,
            qualified.canonical_name,
            qualified.set_name,
            qualified.year,
            qualified.card_number,
            qualified.primary_image_url,
            qualified.mirrored_primary_image_url,
            qualified.mirrored_primary_thumb_url,
            qualified.grade,
            qualified.market_price,
            qualified.market_price_as_of,
            qualified.market_confidence_score,
            qualified.market_low_confidence,
            qualified.active_listings_7d,
            qualified.snapshot_count_30d,
            qualified.change_pct_24h,
            qualified.change_pct_7d,
            qualified.jp_latest_price,
            qualified.jp_latest_price_as_of,
            qualified.yahoo_jp_price,
            qualified.yahoo_jp_price_jpy,
            qualified.yahoo_jp_sample_count,
            qualified.yahoo_jp_observed_at,
            qualified.snkrdunk_price,
            qualified.snkrdunk_price_jpy,
            qualified.snkrdunk_sample_count,
            qualified.snkrdunk_observed_at,
            qualified.snkrdunk_product_code,
            qualified.has_market_price,
            qualified.yahoo_jp_qualified,
            qualified.snkrdunk_qualified,
                CASE
                    WHEN qualified.snkrdunk_qualified AND (NOT qualified.yahoo_jp_qualified OR COALESCE(qualified.snkrdunk_sample_count, 0) > COALESCE(qualified.yahoo_jp_sample_count, 0)) THEN 'snkrdunk'::text
                    WHEN qualified.yahoo_jp_qualified THEN 'yahoo_jp'::text
                    ELSE NULL::text
                END AS picked_jp_source
           FROM qualified
        )
 SELECT canonical_slug,
    canonical_name,
    set_name,
    year,
    card_number,
    primary_image_url,
    mirrored_primary_image_url,
    mirrored_primary_thumb_url,
    grade,
    market_price,
    market_price_as_of,
    market_confidence_score,
    market_low_confidence,
    active_listings_7d,
    snapshot_count_30d,
    change_pct_24h,
    change_pct_7d,
    yahoo_jp_price,
    yahoo_jp_price_jpy,
    yahoo_jp_sample_count,
    yahoo_jp_observed_at,
    snkrdunk_price,
    snkrdunk_price_jpy,
    snkrdunk_sample_count,
    snkrdunk_observed_at,
    snkrdunk_product_code,
    has_market_price,
    yahoo_jp_qualified,
    snkrdunk_qualified,
    yahoo_jp_qualified OR snkrdunk_qualified AS has_qualified_jp_source_price,
        CASE
            WHEN picked_jp_source IS NOT NULL THEN picked_jp_source
            WHEN has_market_price THEN 'market'::text
            ELSE NULL::text
        END AS display_price_source,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_price
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_price
            WHEN has_market_price THEN market_price
            ELSE NULL::numeric
        END AS display_price_usd,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_price_jpy
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_price_jpy
            ELSE NULL::numeric
        END AS display_price_jpy,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_sample_count
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_sample_count
            WHEN has_market_price THEN snapshot_count_30d
            ELSE NULL::integer
        END AS display_price_sample_count,
        CASE
            WHEN picked_jp_source = 'snkrdunk'::text THEN snkrdunk_observed_at
            WHEN picked_jp_source = 'yahoo_jp'::text THEN yahoo_jp_observed_at
            WHEN has_market_price THEN market_price_as_of
            ELSE NULL::timestamp with time zone
        END AS display_price_as_of,
    has_market_price OR yahoo_jp_qualified OR snkrdunk_qualified AS covered_by_price,
    jp_latest_price,
    jp_latest_price_as_of
   FROM picked;

-- Unique index: O(index) per-slug lookups (the whole point), and the
-- prerequisite for ever upgrading the refresh to CONCURRENTLY (e.g. via
-- pg_cron outside a transaction).
create unique index public_jp_price_coverage_slug_idx
  on public.public_jp_price_coverage (canonical_slug);

analyze public.public_jp_price_coverage;

grant select on public.public_jp_price_coverage to anon, authenticated;

-- Carries forward the dropped view's COMMENT rationale (20260604170000)
-- plus the new refresh contract.
comment on materialized view public.public_jp_price_coverage is
  'Public read snapshot for JP card price coverage. Starts from JP canonical_cards and exposes a trusted display price from Yahoo! JP, Snkrdunk, or the guarded public_card_metrics market price without granting direct access to private JP companion price tables. MATERIALIZED (20260615090000) so per-slug lookups are index hits instead of full-view materializations; refreshed hourly at :40 by refresh_jp_price_coverage() from the refresh-jp-price-display cron. Ad-hoc JP price fixes outside the crons need a manual select public.refresh_jp_price_coverage() to surface before the next tick.';

-- Cron-invoked refresh wrapper. SECURITY DEFINER because the matview is
-- owned by the migration role; service_role calls it via PostgREST rpc.
-- statement_timeout 0: a plain REFRESH waits behind readers for an
-- ACCESS EXCLUSIVE lock and that wait counts toward the caller's role
-- timeout (sibling JP secdef functions pin the same). lock_timeout 10s
-- bounds the inverse: under a reader pile-up the refresh cancels
-- LOUDLY (cron 500s, snapshot keeps last-good data) and retries next
-- hour, instead of queueing new readers behind its lock wait.
create or replace function public.refresh_jp_price_coverage()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to 0
set lock_timeout to '10s'
as $$
begin
  refresh materialized view public.public_jp_price_coverage;
  -- Plain REFRESH rewrites the heap; re-collect stats immediately
  -- rather than waiting on autovacuum (cheap at ~20.7k rows).
  analyze public.public_jp_price_coverage;
end;
$$;

revoke all on function public.refresh_jp_price_coverage() from public;
revoke all on function public.refresh_jp_price_coverage() from anon, authenticated;
grant execute on function public.refresh_jp_price_coverage() to service_role;

-- Repo convention for migrations introducing an rpc-called function;
-- hosted Supabase also auto-reloads on DDL, this just removes the
-- first-call PGRST202 race.
notify pgrst, 'reload schema';
