-- Revert: decouple the per-printing display refresh from refresh_price_changes().
--
-- INCIDENT. 20260601120000 made the refresh_price_changes() /
-- refresh_price_changes_for_cards() wrappers call BOTH refresh_price_changes_core
-- AND refresh_per_printing_raw_price_display in one synchronous call. The no-arg
-- wrapper (the 12-hourly refresh-card-metrics cron) then had to do core over ~33k
-- canonical rows (which already runs for minutes — provider_variant_match_score is
-- evaluated per surviving variant) PLUS a ~49k-row per-printing pass in the same
-- request. That pushed the cron past its function timeout; Vercel retried, and
-- multiple concurrent runs thrashed I/O and held card_metrics locks — a 45-minute
-- runaway with statement_timeout=0 (observed pid 731897). The daily change/median
-- refresh stopped landing.
--
-- Fix: restore the wrappers to core-only (their pre-20260601120000 behavior). core
-- still computes + writes canonical latest_price — that part is cheap and stays.
-- The per-printing pass (refresh_per_printing_raw_price_display, retained) must run
-- OFF the critical path on its own cadence; it does not belong inside the
-- latency-sensitive price-change refresh. A dedicated cron for it is a follow-up.
--
-- supersedes: 20260601120000_freshest_price_and_per_printing_display.sql
--             (refresh_price_changes / refresh_price_changes_for_cards wrappers —
--              removes the per-printing call; core body unchanged.)

create or replace function public.refresh_price_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
begin
  return public.refresh_price_changes_core(null);
end;
$$;

create or replace function public.refresh_price_changes_for_cards(p_canonical_slugs text[])
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
set lock_timeout = 0
as $$
declare
  v_scope text[];
begin
  select coalesce(array_agg(distinct scope_slug), '{}'::text[])
  into v_scope
  from unnest(coalesce(p_canonical_slugs, '{}'::text[])) as input(scope_slug)
  where scope_slug is not null
    and trim(scope_slug) <> '';

  if coalesce(array_length(v_scope, 1), 0) = 0 then
    return jsonb_build_object('updated', 0, 'nulled', 0);
  end if;

  return public.refresh_price_changes_core(v_scope);
end;
$$;

-- SECURITY DEFINER functions stay locked to service-role callers.
revoke all on function public.refresh_price_changes() from public, anon, authenticated;
revoke all on function public.refresh_price_changes_for_cards(text[]) from public, anon, authenticated;
