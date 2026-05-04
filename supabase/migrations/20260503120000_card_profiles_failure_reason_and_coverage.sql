-- 20260503120000_card_profiles_failure_reason_and_coverage.sql
--
-- Persist `failure_reason` on card_profiles + add an operator-facing
-- coverage view.
--
-- Why this migration exists
-- -------------------------
-- Three earlier commits closed the silent-fallback hole on card profile
-- generation (e3f2549, 9b332de, 564ce8c). Today, generateCardProfile()
-- in lib/ai/card-profile-summary.ts attaches a `failureReason` to every
-- fallback row it emits ("llm-threw:AbortError:...", "parse-miss",
-- etc.). The cron then stuffs that reason into a per-run failureBuckets
-- summary in the HTTP response.
--
-- But the reason itself was never persisted anywhere. After the cron
-- run finishes, the operator-facing diagnostic data evaporates: there
-- is no way to ask "of the cards currently on fallback, how many got
-- there because of timeouts vs parse misses vs auth errors?"
--
-- This migration:
--   1. Adds card_profiles.failure_reason — paired with the existing
--      `source` column, this is the per-row provenance trail.
--   2. Adds a partial index because the dominant query is
--      `where failure_reason is not null` for trend reports; the
--      column is null on every successful llm row (the majority once
--      the backlog drains), so a partial index is right.
--   3. Adds a card_profile_coverage view that aggregates source
--      distribution + recency + failure_reason coverage in a single
--      cheap read. Locked to service-role — the view exposes
--      operational metadata (failure-reason buckets, drain rate)
--      that has no business reaching anon clients.

alter table public.card_profiles
  add column if not exists failure_reason text null;

comment on column public.card_profiles.failure_reason is
  'Why this row landed on source=fallback. Set by '
  'generateCardProfile() in lib/ai/card-profile-summary.ts. '
  'Null when source=llm. Common buckets: '
  '"llm-threw:<ErrorName>:<message>", "parse-miss".';

create index if not exists card_profiles_failure_reason_idx
  on public.card_profiles (failure_reason)
  where failure_reason is not null;

-- ── Coverage view ───────────────────────────────────────────────────────────
--
-- One cheap aggregate read for the admin coverage endpoint. Returns
-- one row per source value ('llm' | 'fallback'). The endpoint adds
-- percentages and joins in a top-N failure-reason breakdown, computed
-- separately so the bucketing logic stays in app code (easier to
-- evolve than a SQL function).

create or replace view public.card_profile_coverage as
select
  source,
  count(*)                                                       as profile_count,
  count(*) filter (where updated_at > now() - interval '24 hours') as updated_24h,
  count(*) filter (where updated_at > now() - interval '7 days')  as updated_7d,
  count(*) filter (where failure_reason is not null)             as with_failure_reason
from public.card_profiles
group by source;

comment on view public.card_profile_coverage is
  'Per-source aggregates over card_profiles for the admin coverage '
  'endpoint. Service-role only — operational metadata.';

-- ── Failure-reason buckets ──────────────────────────────────────────────────
--
-- Buckets failure_reason strings so the admin endpoint can show a
-- top-N breakdown without fetching every fallback row.
--   "llm-threw:AbortError:request aborted"  → "llm-threw:AbortError"
--   "llm-threw:TypeError:fetch failed"      → "llm-threw:TypeError"
--   "parse-miss"                            → "parse-miss"
-- The first two split_parts capture <category>:<error name> for the
-- llm-threw family; for non-colon reasons the bucket is the full
-- string. Sorted desc so a plain `select * from ... limit 10` is the
-- top-N read.

create or replace view public.card_profile_failure_buckets as
select
  case
    when failure_reason like '%:%' then
      split_part(failure_reason, ':', 1)
      || ':'
      || split_part(failure_reason, ':', 2)
    else failure_reason
  end                                                              as bucket,
  count(*)                                                         as count
from public.card_profiles
where failure_reason is not null
group by 1
order by count(*) desc;

comment on view public.card_profile_failure_buckets is
  'Top-N failure_reason buckets for the admin coverage endpoint. '
  'Service-role only.';

-- Lock down: cron + admin call via dbAdmin (service role).
revoke all on public.card_profile_coverage        from public, anon, authenticated;
revoke all on public.card_profile_failure_buckets from public, anon, authenticated;
