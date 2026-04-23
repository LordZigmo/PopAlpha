-- 20260423020000_phase2f_derive_columns_trigger.sql
--
-- Phase 2f: BEFORE INSERT trigger on price_history_points that derives
-- printing_id / finish / provider_variant_token from (variant_ref,
-- canonical_slug) using the same classifier that powered the Phase 2c
-- backfill.
--
-- Why a trigger instead of editing ingestion code:
--   Ingestion writes price_history_points from ~9+ call sites across
--   lib/backfill/*. Updating each one is error-prone and creates drift
--   between call sites. A single BEFORE INSERT trigger centralizes the
--   derivation so future ingestion paths get it for free. If the
--   classifier is wrong, we fix it in one place.
--
-- Behavior:
--   - Only sets columns when they are NULL on the incoming row (ingestion
--     may set them explicitly — don't clobber).
--   - For canonical '<uuid>::RAW' rows: printing_id = base_uuid, finish
--     from card_printings.finish for that id.
--   - For Scrydex provider-history '<uuid>::<sku>::RAW' rows: derives
--     finish via normalize_scrydex_finish; looks up the matching
--     (slug, finish) card_printings row for printing_id.
--   - For rows whose finish can't be resolved (graded-contaminated,
--     UNKNOWN-classifier, missing card_printings row), leaves columns
--     NULL — Phase 1 picker keeps those functional via safety-net.
--
-- Rollback: drop trigger + function.

create or replace function public.price_history_points_derive_printing_columns()
returns trigger
language plpgsql
as $$
declare
  v_token text;
  v_finish text;
  v_base_pid uuid;
  v_resolved_pid uuid;
begin
  -- Skip if all three target columns are already populated
  -- (explicit ingestion or re-UPDATE that already set them).
  if new.printing_id is not null
     and new.finish is not null then
    return new;
  end if;

  -- Skip graded / non-raw rows — they don't belong in the printing model.
  if new.variant_ref is null
     or new.variant_ref not like '%::RAW'
     or new.variant_ref like '%::GRADED::%' then
    return new;
  end if;

  v_base_pid := public.variant_ref_base_printing_id(new.variant_ref);
  v_token := public.variant_ref_provider_token(new.variant_ref);

  if v_token is not null then
    -- Provider-history shape: derive finish from token, look up printing_id
    -- by (slug, derived_finish).
    v_finish := public.normalize_scrydex_finish(v_token);
    if v_finish in ('NON_HOLO','HOLO','REVERSE_HOLO','ALT_HOLO') then
      select cp.id into v_resolved_pid
      from public.card_printings cp
      where cp.canonical_slug = new.canonical_slug
        and cp.finish = v_finish
      limit 1;
      if v_resolved_pid is not null then
        new.printing_id := coalesce(new.printing_id, v_resolved_pid);
        new.finish := coalesce(new.finish, v_finish);
      end if;
    end if;
    new.provider_variant_token := coalesce(new.provider_variant_token, v_token);
  elsif v_base_pid is not null then
    -- Canonical shape (<uuid>::RAW): finish comes from the card_printings
    -- row identified by the leading UUID. printing_id = that UUID.
    select cp.finish into v_finish
    from public.card_printings cp
    where cp.id = v_base_pid
    limit 1;
    if v_finish is not null then
      new.printing_id := coalesce(new.printing_id, v_base_pid);
      new.finish := coalesce(new.finish, v_finish);
    end if;
  end if;

  return new;
end $$;

revoke execute on function public.price_history_points_derive_printing_columns()
  from public, anon, authenticated;

drop trigger if exists price_history_points_derive_columns
  on public.price_history_points;

create trigger price_history_points_derive_columns
  before insert on public.price_history_points
  for each row
  execute function public.price_history_points_derive_printing_columns();
