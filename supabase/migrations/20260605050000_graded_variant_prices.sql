-- Grader-split: per-(printing, grader, grade) graded price series so PSA 10 != CGC 10.
--
-- Problem: card_metrics is keyed by (canonical_slug, printing_id, grade) with NO
-- grader dimension, so a card's "G10" row medians PSA 10 + CGC 10 + BGS 10 + TAG 10
-- into one pooled number (Gym Challenge Rocket's Zapdos 1st-Ed: PSA G10 ~$3,431,
-- CGC G10 ~$634, CGC G10_PERFECT ~$1,344, BGS G9.5 ~$905 — all collapse to a
-- meaningless midpoint). Tapping a grading agency in the iOS detail only re-points the
-- chart today; the headline price stays pooled. The per-grader price ALREADY exists in
-- variant_price_daily/latest (keyed by variant_ref, which encodes the grader:
-- <pid>::<set-pt>::GRADED::<grader>::<bucket>::RAW) and per-grader signals live in
-- variant_metrics (its `provider` column IS the grader) — what is missing is a
-- per-grader price + median surface for the card detail.
--
-- This adds that surface as an ISOLATED table (no change to card_metrics or any of its
-- many consumers — homepage / holdings / RAW headline are untouched). It parses the
-- grader+bucket+printing straight from variant_ref, so it does NOT depend on the
-- (separate, deferred) graded grade re-stamp.
--
-- NO per-grader change_pct: graded series are sparse (most combos have 1-6 sales over
-- 30 days), so a 24h/7d change would compare a datapoint to itself or to noise. Per the
-- trust principle we surface price + median + 30D range + sample count (the iOS graded
-- summary already shows exactly these), and no change badge — matching today's graded
-- behavior. If graded volume densifies, a follow-up can add change with a sparse-aware
-- baseline; YAGNI until then.
--
-- Refresh is BOUNDED + watermark-paced (same shape as refresh_per_printing_raw_price_display,
-- 20260602030000): variant_metrics is the small authoritative graded-combo driver
-- (24,260 cards / 156,580 combos), so we never run the timing-out full ::GRADED:: regex
-- scan over variant_price_daily — we pick the N stalest cards and scope the price
-- aggregation by slug (index-backed). A side watermark table advances every picked card
-- (incl. cards whose graded data has aged out, so they rotate out instead of clogging).
--
-- Scope (v1): the long ::GRADED:: variant_ref form, verified against prod
-- variant_price_daily (810,605 rows / 24,763 cards, current through today) — grader =
-- segment 4, bucket = segment 5 in the G10/G9_5/... vocabulary the iOS graded view
-- (CardService.fetchGradedCardMetrics) already filters on. The legacy 3-segment short
-- form (<pid>::PROVIDER::token, ~3k rows / 43 cards / 0.4%) is excluded — a follow-up can
-- fold it in if it ever matters. printing_id is parsed from the ref and is part of the
-- PK, so — unlike the nullable sibling columns that carry `references card_printings(id)
-- on delete set null` — it intentionally has NO printing FK: a NOT-NULL PK member can't be
-- set-null, an on-delete-cascade FK would let one stale parsed ref fail the whole refresh,
-- and the canonical_slug cascade already covers card deletion; the rare orphan row (stale
-- printing, or a slug that fully left variant_metrics) is unread (iOS only queries a
-- printing it is displaying) and bounded.
--
-- All new objects — supersedes nothing.

-- ---------------------------------------------------------------------------
-- 1. Output table: one row per (canonical_slug, printing_id, grade-bucket, grader).
--    printing_id is NEVER null for graded combos (verified: 0/156,580 null), so the
--    natural PK is the 4-tuple — no nulls-not-distinct gymnastics needed. Columns
--    mirror the graded fields card_metrics already exposes (+ grader) so the iOS
--    GradedCardMetricRow decode is a drop-in: it just adds `grader`.
-- ---------------------------------------------------------------------------
create table if not exists public.graded_variant_prices (
  canonical_slug      text        not null references public.canonical_cards(slug) on delete cascade,
  printing_id         uuid        not null,
  grade               text        not null,   -- bucket: LE_7, G8, G9, G9_5, G10, G10_PERFECT
  grader              text        not null,   -- PSA, CGC, BGS, TAG
  latest_price        numeric     null,
  latest_price_as_of  timestamptz null,
  market_price        numeric     null,       -- 14-day median (the emphasized headline)
  market_price_as_of  timestamptz null,
  median_7d           numeric     null,
  median_30d          numeric     null,
  low_30d             numeric     null,
  high_30d            numeric     null,
  snapshot_count_30d  integer     not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (canonical_slug, printing_id, grade, grader)
);

alter table public.graded_variant_prices enable row level security;

create index if not exists graded_variant_prices_slug_idx
  on public.graded_variant_prices (canonical_slug);

comment on table public.graded_variant_prices is
  'Per-(printing, grader, grade) graded price surface so PSA 10 != CGC 10. Derived from '
  'variant_price_daily/latest by refresh_graded_variant_prices; read via public_graded_variant_prices.';
comment on column public.graded_variant_prices.grade is
  'Grade bucket in the G-vocabulary: LE_7, G8, G9, G9_5, G10, G10_PERFECT (matches the iOS graded view).';
comment on column public.graded_variant_prices.grader is
  'Grading agency: PSA, CGC, BGS, TAG.';
comment on column public.graded_variant_prices.market_price is
  '14-day median close (the emphasized headline); median_7d / median_30d are the shorter / longer windows.';

-- ---------------------------------------------------------------------------
-- 2. Watermark for "stalest-first" bounded rotation. One row per graded card
--    (incl. cards whose graded data aged out — they still get stamped so the
--    cursor advances and never clogs on dead cards). Tiny (~24k rows).
-- ---------------------------------------------------------------------------
create table if not exists public.graded_variant_prices_refresh_state (
  canonical_slug text        not null primary key,
  refreshed_at   timestamptz not null default now()
);

alter table public.graded_variant_prices_refresh_state enable row level security;

create index if not exists graded_variant_prices_refresh_state_idx
  on public.graded_variant_prices_refresh_state (refreshed_at asc nulls first);

-- ---------------------------------------------------------------------------
-- 3. Public read view (mirrors public_card_metrics; iOS + web read this).
--    SECURITY INVOKER = false (default) → bypasses RLS on the base table for
--    anon/authenticated, same pattern as the other public_* views.
-- ---------------------------------------------------------------------------
create or replace view public.public_graded_variant_prices as
  select * from public.graded_variant_prices;

grant select on public.public_graded_variant_prices to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Bounded, watermark-paced refresh.
--    Driver: variant_metrics (small; provider = grader). Price source:
--    variant_price_daily/latest, scoped to the picked cards (slug index → the
--    ::GRADED:: regex only touches scoped rows).
-- ---------------------------------------------------------------------------
create or replace function public.refresh_graded_variant_prices(p_max_cards int default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  picked_count  int := 0;
  written_count int := 0;
begin
  -- The N stalest graded cards (NULL p_max_cards = all → one-shot/manual backfill).
  -- variant_metrics is the authoritative graded-combo source; left-join the watermark.
  create temporary table _gvp_cards on commit drop as
  select vm.canonical_slug
  from (
    select distinct canonical_slug
    from public.variant_metrics
    where provider in ('PSA','CGC','BGS','TAG')
  ) vm
  left join public.graded_variant_prices_refresh_state st
    on st.canonical_slug = vm.canonical_slug
  order by st.refreshed_at asc nulls first, vm.canonical_slug
  limit p_max_cards;

  select count(*) into picked_count from _gvp_cards;

  -- Parsed graded daily series, scoped to the picked cards. seg1=printing_id,
  -- seg4=grader, seg5=bucket. The uuid guard keeps the ::uuid cast safe.
  create temporary table _gvp_daily on commit drop as
  select
    vpd.canonical_slug,
    split_part(vpd.variant_ref,'::',1)::uuid as printing_id,
    split_part(vpd.variant_ref,'::',4)       as grader,
    split_part(vpd.variant_ref,'::',5)       as grade,
    vpd.as_of_date,
    vpd.close_price
  from public.variant_price_daily vpd
  join _gvp_cards c on c.canonical_slug = vpd.canonical_slug
  where vpd.variant_ref like '%::GRADED::%'
    and split_part(vpd.variant_ref,'::',4) in ('PSA','CGC','BGS','TAG')
    and split_part(vpd.variant_ref,'::',5) in ('LE_7','G8','G9','G9_5','G10','G10_PERFECT')
    and split_part(vpd.variant_ref,'::',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and vpd.close_price is not null
    and vpd.close_price > 0
    and vpd.as_of_date >= current_date - 33;

  -- Re-derive every picked card's graded rows from scratch: drop the old rows (so
  -- combos whose data aged out vanish instead of going stale), then insert current.
  delete from public.graded_variant_prices g
  using _gvp_cards c
  where g.canonical_slug = c.canonical_slug;

  with agg as (
    select
      canonical_slug, printing_id, grader, grade,
      percentile_cont(0.5) within group (order by close_price) filter (where as_of_date >= current_date - 14) as market_price,
      (max(as_of_date) filter (where as_of_date >= current_date - 14))::timestamptz as market_price_as_of,
      percentile_cont(0.5) within group (order by close_price) filter (where as_of_date >= current_date - 7)  as median_7d,
      percentile_cont(0.5) within group (order by close_price) filter (where as_of_date >= current_date - 30) as median_30d,
      min(close_price) filter (where as_of_date >= current_date - 30) as low_30d,
      max(close_price) filter (where as_of_date >= current_date - 30) as high_30d,
      count(*)         filter (where as_of_date >= current_date - 30) as snapshot_count_30d
    from _gvp_daily
    group by canonical_slug, printing_id, grader, grade
  ),
  latest as (
    select distinct on (canonical_slug, printing_id, grader, grade)
      vpl.canonical_slug,
      split_part(vpl.variant_ref,'::',1)::uuid as printing_id,
      split_part(vpl.variant_ref,'::',4)       as grader,
      split_part(vpl.variant_ref,'::',5)       as grade,
      vpl.latest_price,
      vpl.latest_observed_at
    from public.variant_price_latest vpl
    join _gvp_cards c on c.canonical_slug = vpl.canonical_slug
    where vpl.variant_ref like '%::GRADED::%'
      and split_part(vpl.variant_ref,'::',4) in ('PSA','CGC','BGS','TAG')
      and split_part(vpl.variant_ref,'::',5) in ('LE_7','G8','G9','G9_5','G10','G10_PERFECT')
      and split_part(vpl.variant_ref,'::',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and vpl.latest_price is not null
      and vpl.latest_price > 0
    order by canonical_slug, printing_id, grader, grade, vpl.latest_observed_at desc
  ),
  computed as (
    select
      canonical_slug, printing_id, grade, grader,
      lt.latest_price, lt.latest_observed_at,
      market_price, market_price_as_of,
      median_7d, median_30d, low_30d, high_30d,
      coalesce(snapshot_count_30d, 0) as snapshot_count_30d
    from agg
    left join latest lt using (canonical_slug, printing_id, grader, grade)
  ),
  do_insert as (
    insert into public.graded_variant_prices
      (canonical_slug, printing_id, grade, grader, latest_price, latest_price_as_of,
       market_price, market_price_as_of, median_7d, median_30d, low_30d, high_30d,
       snapshot_count_30d, updated_at)
    select
      canonical_slug, printing_id, grade, grader, latest_price, latest_observed_at,
      market_price, market_price_as_of, median_7d, median_30d, low_30d, high_30d,
      snapshot_count_30d, now()
    from computed
    returning 1
  )
  select count(*) into written_count from do_insert;

  -- Stamp the watermark for EVERY picked card (incl. dead ones) so the cursor
  -- advances and successive cron ticks cycle through the whole graded set.
  insert into public.graded_variant_prices_refresh_state (canonical_slug, refreshed_at)
  select canonical_slug, now() from _gvp_cards
  on conflict (canonical_slug) do update set refreshed_at = now();

  return jsonb_build_object(
    'graded_cards_scoped', picked_count,
    'graded_rows_written', written_count
  );
end;
$$;

revoke all on function public.refresh_graded_variant_prices(int) from public, anon, authenticated;
