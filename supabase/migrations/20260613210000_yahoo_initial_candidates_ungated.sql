-- Ungate Yahoo! JP initial-coverage candidate selection: attempt-once-then-park.
--
-- supersedes: 20260602080000_jp_initial_candidate_scan_rpcs.sql
--   That file defined TWO functions. This migration redefines ONLY
--   scan_yahoo_initial_candidates; the latest body of
--   scan_snkrdunk_initial_candidates remains there, unchanged.
--
-- What changes
-- ------------
-- The prior body required `EXISTS provider_card_map (mapping_status =
-- 'MATCHED')` — a Scrydex-mapping gate — before a JP card could EVER be
-- selected for a first-pass Yahoo! scrape. That gate moves out of the WHERE
-- clause and survives only as the tier split between never-attempted classes:
--
--   tier 1 = never-attempted WITH a MATCHED provider_card_map row
--            (exactly the prior tier-1 population, same secondary order
--            created_at DESC — selection is byte-for-byte unchanged until
--            this tier drains)
--   tier 2 = never-attempted WITHOUT one (the class the old gate excluded
--            from ever being tried)
--   tier 3 = attempted-but-no-price (the prior tier 2; the gate is dropped
--            here too, so a card whose mapping is later quarantined keeps
--            re-probing on parking expiry. At write time this is a no-op:
--            all 6,309 attempted-no-price cards are gate-included)
--
-- p_suppressed and the no-price NOT EXISTS (grade='RAW') are unchanged.
-- Misses need no new machinery: run-yahoo-jp-daily already parks
-- low-sample/no-query slugs for NONPRODUCTIVE_RETRY_HOURS = 720h (and
-- scrape/write failures for TRANSIENT_RETRY_HOURS = 6h) via p_suppressed.
--
-- Why remove the gate (measured evidence, 2026-06-12)
-- ---------------------------------------------------
-- * The gate excluded 5,526 never-attempted JP cards (95% pre-2017 vintage)
--   — measured as identical to the "unreachable by ANY pricing source" set,
--   i.e. the gate was the only thing keeping these cards permanently
--   priceless.
-- * Vintage gate-INCLUDED cards convert at 63% on Yahoo — the HIGHEST of any
--   era — so the excluded class's vintage skew argues FOR trying it, not
--   against.
-- * 96.4% of the excluded cards have native name+set fields, so
--   buildPrecisionQuery produces the same query shape the included class
--   uses.
-- * The route's old "MATCHED Scrydex mapping => likely Yahoo listings" proxy
--   was an asserted, never-measured correlation (comment already removed in
--   #233). Attempt-once-then-park measures instead of assuming.
-- * Budget: initial-coverage holds ~12 slots/tick (50-card batch, 75%
--   reserved for stale-refresh), hourly cron => ~288/day. Prod backlog at
--   write time: tier 1 = 4,038 (~14 days to drain), then tier 2 = 5,526
--   (~19 further days); tier 3 = 6,309 cycles behind them on 720h parking.
--
-- Deferred follow-up (not this migration): parking escalation on repeat
-- misses (e.g. backoff beyond 720h) if the parked pool's re-probe demand
-- ever outgrows the ~288/day initial budget.
--
-- Lessons carried from the prior definer (still load-bearing)
-- -----------------------------------------------------------
-- * Server-side RPC, not PostgREST embeds: applying `.eq`/`.is` to a
--   `!left`-embedded to-many relation makes PostgREST DROP the left-join
--   NULL rows — the never-attempted cards we most want — silently degrading
--   selection to a blind alphabetical head (commit 1bdb948, reverted #162,
--   froze rotation ~9 days). Full history in the superseded file's header.
-- * EXISTS, not LEFT JOIN, for attempt-dedup: see the in-body comment.
--
-- SECURITY DEFINER + lockdown re-asserted below, mirroring the prior
-- definer's revoke block for this function.

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
  -- tier is derived from EXISTS probes (NOT a LEFT JOIN to the to-many
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
      case
        -- attempted-but-no-price re-probes LAST: every never-attempted card
        -- gets its first shot before any known miss is retried
        -- (attempt-once-then-park).
        when exists (
          select 1
          from public.jp_ingestion_attempts a
          where a.provider = 'YAHOO_JP'
            and a.canonical_slug = c.slug
        ) then 3
        -- never-attempted with a MATCHED provider mapping: exactly the old
        -- tier-1 population (the gate, demoted from filter to priority).
        when exists (
          select 1
          from public.provider_card_map pcm
          where pcm.canonical_slug = c.slug
            and pcm.mapping_status = 'MATCHED'
        ) then 1
        -- never-attempted without one: the newly admitted class.
        else 2
      end as tier,
      c.created_at
    from public.canonical_cards c
    where c.language = 'JP'
      and not (c.slug = any(p_suppressed))
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

-- SECURITY DEFINER lockdown: re-asserted for the redefined function —
-- read-only candidate selection, locked to service_role-only to match the
-- rest of the JP RPC surface. service_role retains EXECUTE via Supabase
-- defaults.
revoke all on function public.scan_yahoo_initial_candidates(int, text[]) from public, anon, authenticated;
