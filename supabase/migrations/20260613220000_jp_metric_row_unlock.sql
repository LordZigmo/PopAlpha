-- 20260613220000_jp_metric_row_unlock.sql
--
-- supersedes: 20260613150000_jp_display_basis_change.sql
--             (refresh_jp_price_display — the latest prior definer. Body
--              reproduced VERBATIM below; the only additions are the
--              inserted_count declaration, the metric-row INSERT step ahead
--              of the existing jp_scope UPDATE, and the jp_rows_created key
--              in the return jsonb. No existing line changes.)
-- supersedes: 20260607120000_card_metrics_raw_row_history_fallback.sql
--             (refresh_card_metrics AND refresh_card_metrics_for_variants —
--              that file is the latest prior definer of BOTH. Bodies
--              reproduced VERBATIM below; the only change in each is the
--              single added predicate `cm.jp_display_price is null` at the
--              head of delete_scope's WHERE, plus its comment. No
--              UPDATE/INSERT column-list changes anywhere.)
--
-- JP metric-row unlock: let the JP display pipeline CREATE the canonical RAW
-- card_metrics row it writes to, and stop the Scrydex-driven GC from deleting
-- rows whose only data is JP-native.
--
-- PROBLEM
-- -------
-- 7,325 of 20,709 JP canonical cards have NO canonical RAW card_metrics row
-- (grade = 'RAW', printing_id IS NULL). refresh_jp_price_display only UPDATEs
-- existing rows, and refresh_card_metrics only creates rows from Scrydex/PTCG
-- signals (price_snapshots, genuine-raw price_history_points) — exactly what
-- those cards lack. A JP card can have weeks of qualifying Snkrdunk/Yahoo! JP
-- history and still be structurally invisible. 406 cards qualify RIGHT NOW
-- (prod, 2026-06-12) and display nothing for this reason alone.
--
-- WHY THE GC EXEMPTION IS LOAD-BEARING
-- ------------------------------------
-- Both refresh_card_metrics() and refresh_card_metrics_for_variants() end
-- with a GC whose active_keys are built EXCLUSIVELY from Scrydex/PTCG
-- signals: price_snapshots (30d) + the genuine-raw price_history_points
-- fallback (30d). The delete is unconditional over card_metrics:
--
--   delete_scope as (
--     select cm.id from public.card_metrics cm
--     where not exists (select 1 from active_keys ak where ...))
--   delete from public.card_metrics cm using delete_scope ds where cm.id = ds.id;
--
-- No JP-native source feeds active_keys, so every row the INSERT below
-- creates (JP-only data by definition — slugs with Scrydex signals already
-- have rows) would be deleted on the next refresh-card-metrics tick
-- (15 */12 * * *). This is the exact failure mode the 20260508140000
-- yahoo-companion-table header documented ("Each cron tick would delete
-- every row we'd just written"). Companion tables solved it for source
-- prices; the DISPLAY columns (jp_display_price et al.) live on card_metrics
-- itself, so the row needs a GC exemption.
--
-- THE EXEMPTION (narrowest honest predicate)
-- ------------------------------------------
-- delete_scope now skips rows where jp_display_price IS NOT NULL. That
-- column has exactly one writer — refresh_jp_price_display (hourly,
-- 40 * * * *) — which also CLEARS it when a row's JP series ages out of the
-- 14d window. So the exemption tracks "currently displaying a JP-native
-- price" with at most an hour of lag. One zombie path existed — a slug
-- reclassified JP->EN exits the clearer's language='JP' scope and would
-- never be cleared again — closed by scoping the exemption itself to
-- JP-language slugs: non-JP rows get no exemption regardless of
-- jp_display_price residue (migration-reviewer finding).
-- jp_latest_price was considered too, but the same UPDATE sets/clears both
-- from the same hist CTE (each is non-null iff the other is), and
-- public_card_metrics displays JP RAW rows from jp_display_price alone — the
-- single column is the narrowest honest form. Bonus: the exemption also
-- covers the 119 existing JP rows (prod, 2026-06-12) that display a JP price
-- while currently surviving GC only via aging genuine-raw history residue.
--
-- BOUNDED WORK
-- ------------
-- * INSERT step: one-time ~406 rows at apply, then incremental (only slugs
--   newly acquiring qualifying history). The anti-join scans the small 14d
--   jp_card_price_history slice and probes the card_metrics unique index, so
--   the hourly steady-state cost is negligible.
-- * GC exemption: a column predicate plus a canonical_cards PK probe that
--   only runs for rows holding jp_display_price (a few thousand at most);
--   displaying JP rows short-circuit BEFORE the active_keys NOT EXISTS
--   probe.
-- * One-shot refresh_jp_price_display() at the end: the function's normal
--   unbounded full pass (~0.8-4s; see the 20260613150000 header) plus the
--   one-time insert, so the unlocked cards display immediately at apply.
--
-- KNOWN RACE / SCOPE / ROLLBACK (migration-reviewer findings)
-- -----------------------------------------------------------
-- * Apply-time race: an OLD-body refresh_card_metrics(_for_variants) run in
--   flight at apply (pipeline rollups tick :22/:52) deletes from its
--   pre-migration snapshot and can GC freshly inserted rows once. Self-heals
--   at the next hourly :40 display tick (re-insert + refill); post-merge
--   runbook optionally reruns refresh_jp_price_display() after the rollup
--   tick passes.
-- * Per-printing asymmetry (deliberate): the exemption protects ANY row
--   bearing jp_display_price, but the INSERT resurrects canonical RAW rows
--   only — display is canonical-RAW-based. JP slugs whose qualifying history
--   is per-printing-only stay locked.
-- * Rollback: re-assert the three bodies from 20260607120000 +
--   20260613150000 (with supersedes headers); unlocked rows then self-GC on
--   the next metrics tick. No DDL to unwind.
-- * Monitoring follow-up: a jp display staleness alarm
--   (max(jp_display_price_as_of) age) joins the weekly
--   check-jp-source-divergence in the next display PR — a dead display cron
--   would otherwise leave exempted rows showing a stale price indefinitely.

-- ---------------------------------------------------------------------------
-- 1. refresh_card_metrics — body VERBATIM from 20260607120000 (latest prior
--    definer); the only change is the JP-native display exemption predicate
--    at the head of delete_scope's WHERE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_card_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '0'
 SET lock_timeout TO '0'
AS $function$
declare
  affected integer := 0;
  removed integer := 0;
begin
  with raw_history_pts as (
    -- Genuine-raw Scrydex history (same daily raw feed that powers the
    -- per-printing display); fallback price source so a card keeps its RAW row
    -- alive + priced when its price_snapshots RAW row has gone stale.
    select
      php.canonical_slug,
      php.printing_id, -- Phase-3-resolved printing; variant_ref seg1 keeps the base UUID after stamp/edition remap
      php.price as price_value,
      php.ts as observed_at
    from public.price_history_points php
    where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and php.source_window in ('snapshot', '30d')
      and php.ts >= now() - interval '30 days'
      and php.variant_ref like '%::RAW'
      and php.variant_ref not like '%GRADED%'
  ),
  snapshot_raw_keys as (
    -- (slug, printing) combos that already have a fresh raw snapshot; the history
    -- fallback is suppressed for these so the ~30k healthy cards are unchanged.
    select distinct canonical_slug, printing_id
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and grade = 'RAW'
      and observed_at >= now() - interval '30 days'
  ),
  raw_history_fallback as (
    select rhp.canonical_slug, rhp.printing_id, rhp.price_value, rhp.observed_at
    from raw_history_pts rhp
    where rhp.printing_id is not null
      and not exists (
        select 1 from snapshot_raw_keys k
        where k.canonical_slug = rhp.canonical_slug
          and k.printing_id is not distinct from rhp.printing_id
      )
  ),
  raw_history_latest as (
    select distinct on (canonical_slug, printing_id)
      canonical_slug, printing_id, price_value, observed_at
    from raw_history_fallback
    order by canonical_slug, printing_id, observed_at desc
  ),
  all_prices_raw as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'

    union all

    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value,
      observed_at
    from raw_history_fallback
  ),
  all_prices as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw
    where printing_id is not null
  ),
  provider_latest_by_ref_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.provider_ref
    )
      ps.id as snapshot_id,
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end as provider_key,
      ps.provider_ref,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '72 hours'
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      case
        when ps.provider in ('SCRYDEX', 'POKEMON_TCG_API') then 'SCRYDEX'
        else ps.provider
      end,
      ps.provider_ref,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest_raw as (
    select distinct on (
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key
    )
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      pl.price_value,
      pl.observed_at
    from provider_latest_by_ref_raw pl
    left join public.card_printings cp
      on cp.id = pl.printing_id
    order by
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      public.provider_variant_match_score(
        pl.provider_key,
        pl.provider_ref,
        cp.finish,
        cp.edition,
        cp.stamp
      ) desc,
      pl.observed_at desc,
      pl.snapshot_id desc
  ),
  provider_latest_all as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  printing_compare as (
    select
      canonical_slug,
      printing_id,
      grade,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_raw
    group by canonical_slug, printing_id, grade

    union all

    -- history fallback market price for printings with no fresh raw snapshot
    -- (disjoint from the snapshot arm by raw_history_fallback's NOT EXISTS gate).
    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value as scrydex_price,
      observed_at as scrydex_as_of
    from raw_history_latest
  ),
  canonical_fallback_compare as (
    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_all
    where printing_id is null
    group by canonical_slug, grade
  ),
  canonical_compare as (
    select
      scope.canonical_slug,
      null::uuid as printing_id,
      'RAW'::text as grade,
      coalesce(pref.scrydex_price, fallback.scrydex_price) as scrydex_price,
      coalesce(pref.scrydex_as_of, fallback.scrydex_as_of) as scrydex_as_of
    from (
      select distinct canonical_slug
      from all_prices
      where printing_id is null
        and grade = 'RAW'
    ) scope
    left join printing_compare pref
      on pref.canonical_slug = scope.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(scope.canonical_slug)
     and pref.grade = 'RAW'
    left join canonical_fallback_compare fallback
      on fallback.canonical_slug = scope.canonical_slug
     and fallback.grade = 'RAW'
  ),
  provider_compare as (
    select * from printing_compare
    where printing_id is not null
    union all
    select * from canonical_compare
  ),
  base_stats as (
    select
      canonical_slug,
      printing_id,
      grade,
      percentile_cont(0.5) within group (order by price_value)
        filter (where observed_at >= now() - interval '7 days') as median_7d,
      percentile_cont(0.5) within group (order by price_value) as median_30d,
      min(price_value) as low_30d,
      max(price_value) as high_30d,
      stddev_pop(price_value) as stddev_30d,
      percentile_cont(0.1) within group (order by price_value) as p10,
      percentile_cont(0.9) within group (order by price_value) as p90,
      count(*) filter (where observed_at >= now() - interval '7 days') as snapshot_active_7d_count,
      count(*) as snapshot_count_30d
    from all_prices
    group by canonical_slug, printing_id, grade
  ),
  trimmed as (
    select
      ap.canonical_slug,
      ap.printing_id,
      ap.grade,
      percentile_cont(0.5) within group (order by ap.price_value) as trimmed_median_30d
    from all_prices ap
    join base_stats bs
      on bs.canonical_slug = ap.canonical_slug
     and bs.printing_id is not distinct from ap.printing_id
     and bs.grade = ap.grade
    where ap.price_value between bs.p10 and bs.p90
    group by ap.canonical_slug, ap.printing_id, ap.grade
  ),
  history_points_expanded as (
    select
      ph.canonical_slug,
      case
        when split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(ph.variant_ref, '::', 1)::uuid
        else null::uuid
      end as printing_id,
      'RAW'::text as grade,
      ph.ts
    from public.price_history_points ph
    where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= now() - interval '30 days'
  ),
  history_counts as (
    select
      canonical_slug,
      printing_id,
      grade,
      count(*) filter (where ts >= now() - interval '7 days')::integer as history_7d_count,
      count(*)::integer as history_count_30d
    from (
      select canonical_slug, printing_id, grade, ts from history_points_expanded
      union all
      select canonical_slug, null::uuid as printing_id, grade, ts
      from history_points_expanded
      where printing_id is not null
    ) x
    group by canonical_slug, printing_id, grade
  ),
  computed as (
    select
      bs.canonical_slug,
      bs.printing_id,
      bs.grade,
      bs.median_7d,
      bs.median_30d,
      bs.low_30d,
      bs.high_30d,
      t.trimmed_median_30d,
      case
        when bs.median_30d > 0
        then round((bs.stddev_30d / bs.median_30d * 100)::numeric, 2)
        else null
      end as volatility_30d,
      least(
        greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::numeric * 20,
        100
      ) as liquidity_score,
      greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::integer as active_7d_count,
      greatest(coalesce(hc.history_count_30d, 0), bs.snapshot_count_30d)::integer as snapshot_count_30d,
      pc.scrydex_price,
      pc.scrydex_price as market_price,
      case when pc.scrydex_price is not null then pc.scrydex_as_of else null end as market_price_as_of,
      case when pc.scrydex_price is not null then pc.scrydex_as_of else null end as provider_compare_as_of
    from base_stats bs
    left join trimmed t
      on t.canonical_slug = bs.canonical_slug
     and t.printing_id is not distinct from bs.printing_id
     and t.grade = bs.grade
    left join history_counts hc
      on hc.canonical_slug = bs.canonical_slug
     and hc.printing_id is not distinct from bs.printing_id
     and hc.grade = bs.grade
    left join provider_compare pc
      on pc.canonical_slug = bs.canonical_slug
     and pc.printing_id is not distinct from bs.printing_id
     and pc.grade = bs.grade
  ),
  -- NEW: canonical RAW row mirrors the preferred printing's stats instead of the
  -- pooled cross-printing aggregate. Only fires for (printing_id IS NULL, RAW);
  -- every other row passes through unchanged. Gated on pref EXISTENCE
  -- (pref.canonical_slug is not null): present -> use the preferred printing's
  -- stats verbatim incl. NULLs; absent -> keep the pooled fallback.
  computed_mirrored as (
    select
      c.canonical_slug,
      c.printing_id,
      c.grade,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_7d else c.median_7d end as median_7d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_30d else c.median_30d end as median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.low_30d else c.low_30d end as low_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.high_30d else c.high_30d end as high_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.trimmed_median_30d else c.trimmed_median_30d end as trimmed_median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.volatility_30d else c.volatility_30d end as volatility_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.liquidity_score else c.liquidity_score end as liquidity_score,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.active_7d_count else c.active_7d_count end as active_7d_count,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.snapshot_count_30d else c.snapshot_count_30d end as snapshot_count_30d,
      c.scrydex_price,
      c.market_price,
      c.market_price_as_of,
      c.provider_compare_as_of
    from computed c
    left join computed pref
      on c.printing_id is null
     and c.grade = 'RAW'
     and pref.canonical_slug = c.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(c.canonical_slug)
     and pref.grade = 'RAW'
  ),
  ranked as (
    select
      c.*,
      round((
        percent_rank() over (
          partition by
            cc.set_name,
            c.grade,
            case when c.printing_id is null then 'CANONICAL' else 'PRINTING' end
          order by c.median_7d nulls last
        ) * 100
      )::numeric, 2) as percentile_rank
    from computed_mirrored c
    join public.canonical_cards cc
      on cc.slug = c.canonical_slug
  ),
  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from ranked r
    order by
      r.canonical_slug,
      r.printing_id,
      r.grade,
      r.provider_compare_as_of desc nulls last,
      r.market_price_as_of desc nulls last
  )
  insert into public.card_metrics (
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
    scrydex_price,
    pokemontcg_price,
    market_price,
    market_price_as_of,
    provider_compare_as_of,
    updated_at
  )
  select
    r.canonical_slug,
    r.printing_id,
    r.grade,
    r.median_7d,
    r.median_30d,
    r.low_30d,
    r.high_30d,
    r.trimmed_median_30d,
    r.volatility_30d,
    r.liquidity_score,
    r.percentile_rank,
    null,
    r.active_7d_count,
    r.snapshot_count_30d,
    r.scrydex_price,
    null,
    r.market_price,
    r.market_price_as_of,
    r.provider_compare_as_of,
    now()
  from deduped_ranked r
  on conflict (canonical_slug, printing_id, grade) do update set
    median_7d = excluded.median_7d,
    median_30d = excluded.median_30d,
    low_30d = excluded.low_30d,
    high_30d = excluded.high_30d,
    trimmed_median_30d = excluded.trimmed_median_30d,
    volatility_30d = excluded.volatility_30d,
    liquidity_score = excluded.liquidity_score,
    percentile_rank = excluded.percentile_rank,
    active_listings_7d = excluded.active_listings_7d,
    snapshot_count_30d = excluded.snapshot_count_30d,
    scrydex_price = excluded.scrydex_price,
    pokemontcg_price = excluded.pokemontcg_price,
    market_price = excluded.market_price,
    market_price_as_of = excluded.market_price_as_of,
    provider_compare_as_of = excluded.provider_compare_as_of,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;

  with raw_history_fallback_keys as (
    -- mirror of the INSERT block's raw_history_fallback (separate CTE scope):
    -- (slug, printing) RAW combos kept alive by fresh genuine-raw history when no
    -- fresh raw snapshot exists. Guards the delete-scope from pruning them.
    select distinct rp.canonical_slug, rp.printing_id
    from (
      select
        php.canonical_slug,
        php.printing_id -- Phase-3-resolved printing (see raw_history_pts), not variant_ref seg1
      from public.price_history_points php
      where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
        and php.source_window in ('snapshot', '30d')
        and php.ts >= now() - interval '30 days'
        and php.variant_ref like '%::RAW'
        and php.variant_ref not like '%GRADED%'
    ) rp
    where rp.printing_id is not null
      and not exists (
        select 1 from public.price_snapshots ps
        where ps.canonical_slug = rp.canonical_slug
          and ps.grade = 'RAW'
          and ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
          and ps.observed_at >= now() - interval '30 days'
          and ps.printing_id is not distinct from rp.printing_id
      )
  ),
  active_keys as (
    select
      canonical_slug,
      printing_id,
      grade
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'

    union

    select
      canonical_slug,
      null::uuid as printing_id,
      grade
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and observed_at >= now() - interval '30 days'
      and printing_id is not null

    union

    select canonical_slug, printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys

    union

    select canonical_slug, null::uuid as printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys
  ),
  delete_scope as (
    select cm.id
    from public.card_metrics cm
    -- NEW (20260613220000): JP-native display exemption. active_keys is built
    -- exclusively from Scrydex/PTCG signals, but JP-only cards earn their row
    -- from jp_card_price_history via refresh_jp_price_display — without this
    -- predicate the GC would delete every such row each tick (the
    -- 20260508140000 companion-table failure mode, display-row edition).
    -- jp_display_price is cleared by its sole writer within an hour of the JP
    -- series aging out of its 14d window, so exempted rows return to GC
    -- eligibility honestly. The language probe closes the one zombie path:
    -- the clearer's scope is language='JP', so a slug reclassified JP->EN
    -- would never be cleared again — non-JP slugs therefore get NO exemption
    -- regardless of jp_display_price residue (migration-reviewer finding).
    where (
        cm.jp_display_price is null
        or not exists (
          select 1
          from public.canonical_cards jcc
          where jcc.slug = cm.canonical_slug
            and jcc.language = 'JP'
        )
      )
      and not exists (
      select 1
      from active_keys ak
      where ak.canonical_slug = cm.canonical_slug
        and ak.printing_id is not distinct from cm.printing_id
        and ak.grade = cm.grade
    )
  )
  delete from public.card_metrics cm
  using delete_scope ds
  where cm.id = ds.id;

  get diagnostics removed = row_count;

  return jsonb_build_object(
    'ok', true,
    'rows', affected,
    'rowsRemoved', removed
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. refresh_card_metrics_for_variants — body VERBATIM from 20260607120000
--    (latest prior definer); the same single delete_scope exemption as above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_card_metrics_for_variants(keys jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '0'
 SET lock_timeout TO '0'
 SET search_path TO 'public'
AS $function$
declare
  affected integer := 0;
  removed integer := 0;
  v_target_slugs text[];
  v_target_set_count integer := 0;
begin
  if keys is null or jsonb_typeof(keys) <> 'array' or jsonb_array_length(keys) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0,
      'slugCount', 0
    );
  end if;

  with target_keys as (
    select distinct nullif(trim(item->>'canonical_slug'), '') as canonical_slug
    from jsonb_array_elements(keys) item
    where coalesce(item->>'canonical_slug', '') <> ''
  )
  select
    array_agg(tk.canonical_slug order by tk.canonical_slug),
    count(distinct cc.set_name)::integer
  into v_target_slugs, v_target_set_count
  from target_keys tk
  join public.canonical_cards cc
    on cc.slug = tk.canonical_slug;

  if v_target_slugs is null or coalesce(array_length(v_target_slugs, 1), 0) = 0 then
    return jsonb_build_object(
      'ok', true,
      'rows', 0,
      'rowsRemoved', 0,
      'setCount', 0,
      'slugCount', 0
    );
  end if;

  with raw_history_pts as (
    -- see refresh_card_metrics() for rationale; scoped to v_target_slugs here.
    select
      php.canonical_slug,
      php.printing_id, -- Phase-3-resolved printing; variant_ref seg1 keeps the base UUID after stamp/edition remap
      php.price as price_value,
      php.ts as observed_at
    from public.price_history_points php
    where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and php.source_window in ('snapshot', '30d')
      and php.ts >= now() - interval '30 days'
      and php.variant_ref like '%::RAW'
      and php.variant_ref not like '%GRADED%'
      and php.canonical_slug = any(v_target_slugs)
  ),
  snapshot_raw_keys as (
    select distinct canonical_slug, printing_id
    from public.price_snapshots
    where provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and grade = 'RAW'
      and observed_at >= now() - interval '30 days'
      and canonical_slug = any(v_target_slugs)
  ),
  raw_history_fallback as (
    select rhp.canonical_slug, rhp.printing_id, rhp.price_value, rhp.observed_at
    from raw_history_pts rhp
    where rhp.printing_id is not null
      and not exists (
        select 1 from snapshot_raw_keys k
        where k.canonical_slug = rhp.canonical_slug
          and k.printing_id is not distinct from rhp.printing_id
      )
  ),
  raw_history_latest as (
    select distinct on (canonical_slug, printing_id)
      canonical_slug, printing_id, price_value, observed_at
    from raw_history_fallback
    order by canonical_slug, printing_id, observed_at desc
  ),
  all_prices_raw as (
    select
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)

    union all

    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value,
      observed_at
    from raw_history_fallback
  ),
  all_prices as (
    select
      canonical_slug,
      printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      price_value,
      observed_at
    from all_prices_raw
    where printing_id is not null
  ),
  provider_latest_by_ref_raw as (
    select distinct on (
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.provider,
      ps.provider_ref
    )
      ps.id as snapshot_id,
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      'SCRYDEX'::text as provider_key,
      ps.provider_ref,
      ps.price_value,
      ps.observed_at
    from public.price_snapshots ps
    where ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ps.grade = 'RAW'
      and ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)
    order by
      ps.canonical_slug,
      ps.printing_id,
      ps.grade,
      ps.provider,
      ps.provider_ref,
      ps.observed_at desc,
      ps.id desc
  ),
  provider_latest_raw as (
    select distinct on (
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key
    )
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      pl.price_value,
      pl.observed_at
    from provider_latest_by_ref_raw pl
    left join public.card_printings cp
      on cp.id = pl.printing_id
    order by
      pl.canonical_slug,
      pl.printing_id,
      pl.grade,
      pl.provider_key,
      public.provider_variant_match_score(
        pl.provider_key,
        pl.provider_ref,
        cp.finish,
        cp.edition,
        cp.stamp
      ) desc,
      pl.observed_at desc,
      pl.snapshot_id desc
  ),
  provider_latest_all as (
    select
      canonical_slug,
      printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw

    union all

    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      provider_key,
      price_value,
      observed_at
    from provider_latest_raw
    where printing_id is not null
  ),
  printing_compare as (
    select
      canonical_slug,
      printing_id,
      grade,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_raw
    group by canonical_slug, printing_id, grade

    union all

    -- history fallback market price for printings with no fresh raw snapshot
    -- (disjoint from the snapshot arm by raw_history_fallback's NOT EXISTS gate).
    select
      canonical_slug,
      printing_id,
      'RAW'::text as grade,
      price_value as scrydex_price,
      observed_at as scrydex_as_of
    from raw_history_latest
  ),
  canonical_fallback_compare as (
    select
      canonical_slug,
      null::uuid as printing_id,
      grade,
      max(case when provider_key = 'SCRYDEX' then price_value end) as scrydex_price,
      max(case when provider_key = 'SCRYDEX' then observed_at end) as scrydex_as_of
    from provider_latest_all
    where printing_id is null
    group by canonical_slug, grade
  ),
  canonical_compare as (
    select
      scope.canonical_slug,
      null::uuid as printing_id,
      'RAW'::text as grade,
      coalesce(pref.scrydex_price, fallback.scrydex_price) as scrydex_price,
      coalesce(pref.scrydex_as_of, fallback.scrydex_as_of) as scrydex_as_of
    from (
      select distinct canonical_slug
      from all_prices
      where printing_id is null
        and grade = 'RAW'
    ) scope
    left join printing_compare pref
      on pref.canonical_slug = scope.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(scope.canonical_slug)
     and pref.grade = 'RAW'
    left join canonical_fallback_compare fallback
      on fallback.canonical_slug = scope.canonical_slug
     and fallback.grade = 'RAW'
  ),
  provider_compare as (
    select * from printing_compare
    where printing_id is not null
    union all
    select * from canonical_compare
  ),
  base_stats as (
    select
      canonical_slug,
      printing_id,
      grade,
      percentile_cont(0.5) within group (order by price_value)
        filter (where observed_at >= now() - interval '7 days') as median_7d,
      percentile_cont(0.5) within group (order by price_value) as median_30d,
      min(price_value) as low_30d,
      max(price_value) as high_30d,
      stddev_pop(price_value) as stddev_30d,
      percentile_cont(0.1) within group (order by price_value) as p10,
      percentile_cont(0.9) within group (order by price_value) as p90,
      count(*) filter (where observed_at >= now() - interval '7 days') as snapshot_active_7d_count,
      count(*) as snapshot_count_30d
    from all_prices
    group by canonical_slug, printing_id, grade
  ),
  trimmed as (
    select
      ap.canonical_slug,
      ap.printing_id,
      ap.grade,
      percentile_cont(0.5) within group (order by ap.price_value) as trimmed_median_30d
    from all_prices ap
    join base_stats bs
      on bs.canonical_slug = ap.canonical_slug
     and bs.printing_id is not distinct from ap.printing_id
     and bs.grade = ap.grade
    where ap.price_value between bs.p10 and bs.p90
    group by ap.canonical_slug, ap.printing_id, ap.grade
  ),
  history_points_expanded as (
    select
      ph.canonical_slug,
      case
        when split_part(ph.variant_ref, '::', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(ph.variant_ref, '::', 1)::uuid
        else null::uuid
      end as printing_id,
      'RAW'::text as grade,
      ph.ts
    from public.price_history_points ph
    where ph.provider in ('SCRYDEX', 'POKEMON_TCG_API')
      and ph.source_window in ('snapshot', '30d')
      and ph.ts >= now() - interval '30 days'
      and ph.canonical_slug = any(v_target_slugs)
  ),
  history_counts as (
    select
      canonical_slug,
      printing_id,
      grade,
      count(*) filter (where ts >= now() - interval '7 days')::integer as history_7d_count,
      count(*)::integer as history_count_30d
    from (
      select canonical_slug, printing_id, grade, ts from history_points_expanded
      union all
      select canonical_slug, null::uuid as printing_id, grade, ts
      from history_points_expanded
      where printing_id is not null
    ) x
    group by canonical_slug, printing_id, grade
  ),
  computed as (
    select
      bs.canonical_slug,
      bs.printing_id,
      bs.grade,
      bs.median_7d,
      bs.median_30d,
      bs.low_30d,
      bs.high_30d,
      t.trimmed_median_30d,
      case
        when bs.median_30d > 0
        then round((bs.stddev_30d / bs.median_30d * 100)::numeric, 2)
        else null
      end as volatility_30d,
      least(
        greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::numeric * 20,
        100
      ) as liquidity_score,
      greatest(coalesce(hc.history_7d_count, 0), bs.snapshot_active_7d_count)::integer as active_7d_count,
      greatest(coalesce(hc.history_count_30d, 0), bs.snapshot_count_30d)::integer as snapshot_count_30d,
      pc.scrydex_price,
      pc.scrydex_price as market_price,
      pc.scrydex_as_of as market_price_as_of,
      pc.scrydex_as_of as provider_compare_as_of
    from base_stats bs
    left join trimmed t
      on t.canonical_slug = bs.canonical_slug
     and t.printing_id is not distinct from bs.printing_id
     and t.grade = bs.grade
    left join history_counts hc
      on hc.canonical_slug = bs.canonical_slug
     and hc.printing_id is not distinct from bs.printing_id
     and hc.grade = bs.grade
    left join provider_compare pc
      on pc.canonical_slug = bs.canonical_slug
     and pc.printing_id is not distinct from bs.printing_id
     and pc.grade = bs.grade
  ),
  -- NEW: canonical RAW row mirrors the preferred printing's stats (see the full
  -- refresh_card_metrics above for rationale). Same surgical change.
  computed_mirrored as (
    select
      c.canonical_slug,
      c.printing_id,
      c.grade,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_7d else c.median_7d end as median_7d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.median_30d else c.median_30d end as median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.low_30d else c.low_30d end as low_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.high_30d else c.high_30d end as high_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.trimmed_median_30d else c.trimmed_median_30d end as trimmed_median_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.volatility_30d else c.volatility_30d end as volatility_30d,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.liquidity_score else c.liquidity_score end as liquidity_score,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.active_7d_count else c.active_7d_count end as active_7d_count,
      case when c.printing_id is null and c.grade = 'RAW' and pref.canonical_slug is not null then pref.snapshot_count_30d else c.snapshot_count_30d end as snapshot_count_30d,
      c.scrydex_price,
      c.market_price,
      c.market_price_as_of,
      c.provider_compare_as_of
    from computed c
    left join computed pref
      on c.printing_id is null
     and c.grade = 'RAW'
     and pref.canonical_slug = c.canonical_slug
     and pref.printing_id = public.preferred_canonical_raw_printing(c.canonical_slug)
     and pref.grade = 'RAW'
  ),
  ranked as (
    select
      c.*,
      round((
        percent_rank() over (
          partition by
            cc.set_name,
            c.grade,
            case when c.printing_id is null then 'CANONICAL' else 'PRINTING' end
          order by c.median_7d nulls last
        ) * 100
      )::numeric, 2) as percentile_rank
    from computed_mirrored c
    join public.canonical_cards cc
      on cc.slug = c.canonical_slug
  ),
  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from ranked r
    order by
      r.canonical_slug,
      r.printing_id,
      r.grade,
      r.provider_compare_as_of desc nulls last,
      r.market_price_as_of desc nulls last
  )
  insert into public.card_metrics (
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
    scrydex_price,
    pokemontcg_price,
    market_price,
    market_price_as_of,
    provider_compare_as_of,
    updated_at
  )
  select
    r.canonical_slug,
    r.printing_id,
    r.grade,
    r.median_7d,
    r.median_30d,
    r.low_30d,
    r.high_30d,
    r.trimmed_median_30d,
    r.volatility_30d,
    r.liquidity_score,
    r.percentile_rank,
    null,
    r.active_7d_count,
    r.snapshot_count_30d,
    r.scrydex_price,
    r.scrydex_price,
    r.market_price,
    r.market_price_as_of,
    r.provider_compare_as_of,
    now()
  from deduped_ranked r
  on conflict (canonical_slug, printing_id, grade) do update set
    median_7d = excluded.median_7d,
    median_30d = excluded.median_30d,
    low_30d = excluded.low_30d,
    high_30d = excluded.high_30d,
    trimmed_median_30d = excluded.trimmed_median_30d,
    volatility_30d = excluded.volatility_30d,
    liquidity_score = excluded.liquidity_score,
    percentile_rank = excluded.percentile_rank,
    active_listings_7d = excluded.active_listings_7d,
    snapshot_count_30d = excluded.snapshot_count_30d,
    scrydex_price = excluded.scrydex_price,
    pokemontcg_price = excluded.pokemontcg_price,
    market_price = excluded.market_price,
    market_price_as_of = excluded.market_price_as_of,
    provider_compare_as_of = excluded.provider_compare_as_of,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;

  with raw_history_fallback_keys as (
    -- scoped mirror of the INSERT block's raw_history_fallback; guards the
    -- delete-scope from pruning RAW rows kept alive by fresh genuine-raw history.
    select distinct rp.canonical_slug, rp.printing_id
    from (
      select
        php.canonical_slug,
        php.printing_id -- Phase-3-resolved printing (see raw_history_pts), not variant_ref seg1
      from public.price_history_points php
      where php.provider in ('SCRYDEX', 'POKEMON_TCG_API')
        and php.source_window in ('snapshot', '30d')
        and php.ts >= now() - interval '30 days'
        and php.variant_ref like '%::RAW'
        and php.variant_ref not like '%GRADED%'
        and php.canonical_slug = any(v_target_slugs)
    ) rp
    where rp.printing_id is not null
      and not exists (
        select 1 from public.price_snapshots ps
        where ps.canonical_slug = rp.canonical_slug
          and ps.grade = 'RAW'
          and ps.provider in ('SCRYDEX', 'POKEMON_TCG_API')
          and ps.observed_at >= now() - interval '30 days'
          and ps.printing_id is not distinct from rp.printing_id
      )
  ),
  active_keys as (
    select
      ps.canonical_slug,
      ps.printing_id,
      ps.grade
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.canonical_slug = any(v_target_slugs)

    union

    select
      ps.canonical_slug,
      null::uuid as printing_id,
      ps.grade
    from public.price_snapshots ps
    where ps.observed_at >= now() - interval '30 days'
      and ps.printing_id is not null
      and ps.canonical_slug = any(v_target_slugs)

    union

    select canonical_slug, printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys

    union

    select canonical_slug, null::uuid as printing_id, 'RAW'::text as grade
    from raw_history_fallback_keys
  ),
  delete_scope as (
    select cm.id
    from public.card_metrics cm
    where cm.canonical_slug = any(v_target_slugs)
      -- NEW (20260613220000): JP-native display exemption (incl. the
      -- JP->EN language-flip release) — see refresh_card_metrics'
      -- delete_scope above.
      and (
        cm.jp_display_price is null
        or not exists (
          select 1
          from public.canonical_cards jcc
          where jcc.slug = cm.canonical_slug
            and jcc.language = 'JP'
        )
      )
      and not exists (
        select 1
        from active_keys ak
        where ak.canonical_slug = cm.canonical_slug
          and ak.printing_id is not distinct from cm.printing_id
          and ak.grade = cm.grade
      )
  )
  delete from public.card_metrics cm
  using delete_scope ds
  where cm.id = ds.id;

  get diagnostics removed = row_count;

  return jsonb_build_object(
    'ok', true,
    'rows', affected,
    'rowsRemoved', removed,
    'setCount', v_target_set_count,
    'slugCount', coalesce(array_length(v_target_slugs, 1), 0)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. refresh_jp_price_display — body VERBATIM from 20260613150000 (latest
--    prior definer) plus the metric-row INSERT described in the file header.
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
  -- history (same trust bar as `hist` below: price_usd > 0, sample_count >= 3,
  -- inside the 14d window) so the UPDATE below has a row to write. All metric
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
    and coalesce(h.sample_count, 0) >= 3
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

  return jsonb_build_object('jp_updated', updated_count, 'jp_rows_created', inserted_count);
end;
$$;

-- SECURITY DEFINER lockdown: writes card_metrics, so not callable by anon /
-- authenticated. The service-role cron bypasses grants.
revoke all on function public.refresh_jp_price_display(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. One-shot apply-time run (same pattern as 20260613150000): creates the
--    ~406 missing canonical RAW rows AND fills their jp_* display columns in
--    the same invocation, so the unlocked cards display immediately instead
--    of waiting up to an hour for the next refresh-jp-price-display tick.
-- ---------------------------------------------------------------------------
select public.refresh_jp_price_display();
