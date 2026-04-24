-- 20260424000000_phase3_price_snapshots_printing_backfill.sql
--
-- Fix chart-blank bug: after Phase 2b/3a/3b inserted ~8.7k new
-- card_printings rows and remapped price_history_points.printing_id
-- to them, public_card_metrics still had NULL market_price for those
-- printings because card_metrics is derived from price_snapshots, not
-- price_history_points — and price_snapshots.printing_id was never
-- backfilled.
--
-- Reproduction (Bewear Shrouded Fable #53): REVERSE_HOLO market_price
-- was NULL → MarketSummaryCardClient gated the chart render on
-- currentPrice === null → "No market data yet" where a $0.15 chart
-- should render.
--
-- This migration:
--   1. Backfills price_snapshots.printing_id for raw snapshots whose
--      current printing_id doesn't match the (finish, edition, stamp)
--      derived from provider_ref.
--   2. Installs a BEFORE INSERT OR UPDATE trigger on price_snapshots
--      so future rows auto-route (parity with the trigger already on
--      price_history_points from Phase 2f).
--   3. Calls refresh_card_metrics() at the end so market_price /
--      market_price_as_of populate for the newly-routed printings.
--
-- Parity: SQL classifier functions (normalize_scrydex_finish,
-- normalize_scrydex_stamp, normalize_scrydex_edition) are shared with
-- the price_history_points pipeline — one vocabulary source of truth.
--
-- Rollback: drop the trigger + function. The data remap is additive
-- (rows still reference real card_printings ids), so no data rollback
-- is destructive.

--------------------------------------------------------------------------
-- Trigger: BEFORE INSERT OR UPDATE OF provider_ref — routes new rows to
-- the correct (slug, finish, edition, stamp) card_printings row.
--------------------------------------------------------------------------

create or replace function public.price_snapshots_derive_printing_id()
returns trigger language plpgsql as $$
declare
  v_token text;
  v_finish text;
  v_stamp text;
  v_edition text;
  v_resolved_pid uuid;
  v_fallback_edition text;
begin
  if new.grade is distinct from 'RAW' then return new; end if;
  if new.provider not in ('SCRYDEX','POKEMON_TCG_API') then return new; end if;
  if new.provider_ref is null or new.provider_ref like '%::GRADED::%' then return new; end if;

  v_token := substring(new.provider_ref from '^scrydex:[^:]+:([^:]+)$');
  if v_token is null then return new; end if;

  v_finish := public.normalize_scrydex_finish(v_token);
  v_stamp := public.normalize_scrydex_stamp(v_token);
  v_edition := public.normalize_scrydex_edition(v_token);

  -- Stamp- or edition-only tokens have no finish signal: inherit from
  -- the slug's canonical preferred printing.
  if (v_stamp is not null or v_edition is not null) and v_finish = 'UNKNOWN' then
    select cp.finish into v_finish
    from public.card_printings cp
    where cp.id = public.preferred_canonical_raw_printing(new.canonical_slug);
  end if;

  if v_finish not in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO') then return new; end if;
  v_fallback_edition := coalesce(v_edition, 'UNLIMITED');

  select cp.id into v_resolved_pid
  from public.card_printings cp
  where cp.canonical_slug = new.canonical_slug
    and cp.finish = v_finish
    and cp.edition = v_fallback_edition
    and cp.stamp is not distinct from v_stamp
  limit 1;

  -- Fallback for tokens with no edition signal: accept any edition.
  if v_resolved_pid is null and v_edition is null then
    select cp.id into v_resolved_pid
    from public.card_printings cp
    where cp.canonical_slug = new.canonical_slug
      and cp.finish = v_finish
      and cp.stamp is not distinct from v_stamp
    limit 1;
  end if;

  if v_resolved_pid is not null then
    new.printing_id := v_resolved_pid;
  end if;

  return new;
end $$;

revoke execute on function public.price_snapshots_derive_printing_id()
  from public, anon, authenticated;

drop trigger if exists price_snapshots_derive_printing_id on public.price_snapshots;
create trigger price_snapshots_derive_printing_id
  before insert or update of provider_ref on public.price_snapshots
  for each row
  execute function public.price_snapshots_derive_printing_id();

--------------------------------------------------------------------------
-- One-shot backfill: remap raw snapshots whose current printing_id
-- doesn't match the (finish, edition, stamp) implied by provider_ref.
-- Idempotent (WHERE printing_id IS DISTINCT FROM target), resumable.
--------------------------------------------------------------------------

create temporary table if not exists _phase3c_snapshots (
  id uuid primary key,
  canonical_slug text,
  token text,
  finish text,
  edition text,
  stamp text,
  new_printing_id uuid
) on commit drop;

insert into _phase3c_snapshots (id, canonical_slug, token)
select ps.id, ps.canonical_slug,
  substring(ps.provider_ref from '^scrydex:[^:]+:([^:]+)$')
from public.price_snapshots ps
where ps.grade = 'RAW'
  and ps.provider in ('SCRYDEX','POKEMON_TCG_API')
  and ps.provider_ref !~ '::GRADED::'
  and ps.observed_at > now() - interval '30 days';

update _phase3c_snapshots s
set finish = public.normalize_scrydex_finish(s.token),
    edition = public.normalize_scrydex_edition(s.token),
    stamp = public.normalize_scrydex_stamp(s.token)
where s.token is not null;

update _phase3c_snapshots s
set finish = (
  select cp.finish from public.card_printings cp
  where cp.id = public.preferred_canonical_raw_printing(s.canonical_slug)
)
where s.finish = 'UNKNOWN' and (s.stamp is not null or s.edition is not null);

update _phase3c_snapshots s
set new_printing_id = cp.id
from public.card_printings cp
where cp.canonical_slug = s.canonical_slug
  and cp.finish = s.finish
  and cp.edition = coalesce(s.edition, 'UNLIMITED')
  and cp.stamp is not distinct from s.stamp
  and s.finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO');

update public.price_snapshots ps
set printing_id = s.new_printing_id
from _phase3c_snapshots s
where ps.id = s.id
  and s.new_printing_id is not null
  and ps.printing_id is distinct from s.new_printing_id;

-- Repopulate card_metrics so market_price is non-NULL for the newly
-- routed printings. The web chart gates on currentPrice — without this
-- refresh, newly-remapped snapshots would wait up to the next cron tick
-- before the chart shows data.
select public.refresh_card_metrics();
