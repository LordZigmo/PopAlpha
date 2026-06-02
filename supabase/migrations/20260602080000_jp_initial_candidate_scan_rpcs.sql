-- Server-side initial-candidate selection for the JP ingestion crons.
--
-- Why this exists
-- ---------------
-- run-snkrdunk-daily and run-yahoo-jp-daily pick their FIRST-PASS coverage
-- candidates (never-attempted cards first, then attempted-but-still-no-price)
-- by paging the full matched-card universe in 1,000-row chunks and loading two
-- membership Sets (priced + attempted) per page. A prior attempt to move this
-- server-side (commit 1bdb948, reverted in PR #162) tried to express the
-- "never-attempted" filter with PostgREST embedded-relation filters
-- (`.select("...attempts!left(...)").is("attempts.id", null)`). Applying an
-- `.eq`/`.is` to a `!left`-embedded to-many relation makes PostgREST DROP the
-- left-join NULL rows — so the never-attempted cards (which have NO attempt row,
-- i.e. exactly the rows we want) were filtered OUT, the query returned empty, and
-- selection silently degraded to `.order("canonical_slug").range(0, batch)` —
-- a blind alphabetical head. That froze BOTH JP sources' rotation for ~9 days.
--
-- These RPCs re-implement the same tier-1/tier-2 selection with a real
-- `LEFT JOIN ... IS NULL` (and NOT EXISTS for the "no price" predicate), which
-- correctly retains the never-attempted rows. They replace ONLY the per-page
-- priced/attempted Set lookups + the `loadInitial*` paging loop; the stalest-
-- priced re-fetch path (pickRefreshCandidates, with its REFRESH/NONPRODUCTIVE/
-- TRANSIENT cutoffs) stays in the cron and is unchanged.
--
-- Both are NEW functions (no prior definer), so no `-- supersedes:` header is
-- required by check:migrations:fnbody.
--
-- SECURITY DEFINER + locked down (revoke from public/anon/authenticated) to
-- mirror the existing JP RPCs (refresh_jp_price_display, etc.). The service-role
-- cron bypasses grants via Supabase defaults; no other role may execute these.

-- ---------------------------------------------------------------------------
-- 1. scan_snkrdunk_initial_candidates
--
--    MATCHED snkrdunk_product_map products with NO price row yet
--    (no snkrdunk_card_prices row for the product_code — any grade), excluding
--    p_suppressed product codes. Ordered:
--      tier 1 = never-attempted  (no jp_ingestion_attempts row,
--                                 provider='SNKRDUNK', source_key=product_code)
--      tier 2 = attempted-but-no-price
--    Secondary order within each tier: canonical_slug ASC — byte-for-byte the
--    page order the old client loop walked (`.order("canonical_slug", asc)`),
--    so the steady-state rotation is unchanged.
--
--    Dedupe by snkrdunk_product_code (the map can carry >1 MATCHED row for a
--    product code; the old loop deduped via a seenProductCodes Set). DISTINCT ON
--    keeps the lexicographically-smallest canonical_slug per product code, which
--    matches "first row wins" under the canonical_slug ASC scan.
-- ---------------------------------------------------------------------------
create or replace function public.scan_snkrdunk_initial_candidates(
  p_limit int,
  p_suppressed text[] default '{}'
)
returns table (
  canonical_slug text,
  snkrdunk_product_code text,
  tier int
)
language sql
stable
security definer
set search_path = public
as $$
  with deduped as (
    select distinct on (m.snkrdunk_product_code)
      m.canonical_slug,
      m.snkrdunk_product_code,
      -- tier 1 = never attempted (no SNKRDUNK attempt row for this product code)
      case when a.source_key is null then 1 else 2 end as tier
    from public.snkrdunk_product_map m
    left join public.jp_ingestion_attempts a
      on a.provider = 'SNKRDUNK'
     and a.source_key = m.snkrdunk_product_code
    where m.mapping_status = 'MATCHED'
      and m.snkrdunk_product_code is not null
      and not (m.snkrdunk_product_code = any(p_suppressed))
      -- no-price: no snkrdunk_card_prices row for this product code (any grade)
      and not exists (
        select 1
        from public.snkrdunk_card_prices p
        where p.snkrdunk_product_code = m.snkrdunk_product_code
      )
    order by m.snkrdunk_product_code, a.source_key nulls first, m.canonical_slug
  )
  select d.canonical_slug, d.snkrdunk_product_code, d.tier
  from deduped d
  order by d.tier, d.canonical_slug
  limit greatest(p_limit, 0);
$$;

-- ---------------------------------------------------------------------------
-- 2. scan_yahoo_initial_candidates
--
--    JP-language canonical_cards with >=1 MATCHED provider_card_map and NO
--    Yahoo! RAW price row yet (no yahoo_jp_card_prices row with grade='RAW'),
--    excluding p_suppressed slugs. Ordered:
--      tier 1 = never-attempted  (no jp_ingestion_attempts row,
--                                 provider='YAHOO_JP', canonical_slug=slug)
--      tier 2 = attempted-but-no-price
--    Secondary order within each tier: created_at DESC, slug — mirrors the old
--    client loop (`.order("created_at", desc)`), keeping rotation identical.
--
--    The MATCHED-provider gate is an EXISTS (one matched mapping is enough), the
--    direct analogue of the old `provider_card_map!inner(mapping_status=MATCHED)`
--    embed with the per-slug dedupe the client did via its `seen` Set.
-- ---------------------------------------------------------------------------
create or replace function public.scan_yahoo_initial_candidates(
  p_limit int,
  p_suppressed text[] default '{}'
)
returns table (
  canonical_slug text,
  tier int
)
language sql
stable
security definer
set search_path = public
as $$
  -- tier is derived from an EXISTS (NOT a LEFT JOIN to the to-many
  -- jp_ingestion_attempts table). A slug accrues one attempt row per cron tick
  -- and the table has no uniqueness constraint, so a LEFT JOIN would emit the
  -- same canonical_slug once per attempt; with `limit p_limit` applied before
  -- the route's Set dedupe, a heavily-retried no-price slug would duplicate and
  -- crowd out other initial candidates. EXISTS makes each card contribute
  -- exactly ONE row before the limit.
  select s.canonical_slug, s.tier
  from (
    select
      c.slug as canonical_slug,
      case when exists (
        select 1
        from public.jp_ingestion_attempts a
        where a.provider = 'YAHOO_JP'
          and a.canonical_slug = c.slug
      ) then 2 else 1 end as tier,
      c.created_at
    from public.canonical_cards c
    where c.language = 'JP'
      and not (c.slug = any(p_suppressed))
      -- at least one MATCHED provider mapping (mirrors !inner MATCHED embed)
      and exists (
        select 1
        from public.provider_card_map pcm
        where pcm.canonical_slug = c.slug
          and pcm.mapping_status = 'MATCHED'
      )
      -- no-price: no Yahoo! RAW row for this slug (mirrors grade='RAW' Set check)
      and not exists (
        select 1
        from public.yahoo_jp_card_prices y
        where y.canonical_slug = c.slug
          and y.grade = 'RAW'
      )
  ) s
  order by s.tier, s.created_at desc, s.canonical_slug
  limit greatest(p_limit, 0);
$$;

-- SECURITY DEFINER lockdown: read-only candidate selection, but locked to
-- service_role-only to match the rest of the JP RPC surface. service_role
-- retains EXECUTE via Supabase defaults.
revoke all on function public.scan_snkrdunk_initial_candidates(int, text[]) from public, anon, authenticated;
revoke all on function public.scan_yahoo_initial_candidates(int, text[]) from public, anon, authenticated;
