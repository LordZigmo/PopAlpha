-- Phase 2 of retiring the legacy cards-axis.
-- This removes foreign-key dependencies on public.cards / public.card_variants,
-- drops the last legacy card_variant_id surface, and then drops the tables.

do $$
declare
  legacy_targets oid[];
  fk_record record;
begin
  legacy_targets := array_remove(array[
    to_regclass('public.cards'),
    to_regclass('public.card_variants')
  ], null);

  if coalesce(array_length(legacy_targets, 1), 0) = 0 then
    return;
  end if;

  for fk_record in
    select
      con.conname as constraint_name,
      ns.nspname as schema_name,
      rel.relname as table_name
    from pg_constraint con
    join pg_class rel
      on rel.oid = con.conrelid
    join pg_namespace ns
      on ns.oid = rel.relnamespace
    where con.contype = 'f'
      and con.confrelid = any(legacy_targets)
      and ns.nspname = 'public'
  loop
    execute format(
      'alter table %I.%I drop constraint if exists %I',
      fk_record.schema_name,
      fk_record.table_name,
      fk_record.constraint_name
    );
  end loop;
end
$$;

-- Legacy view from the original card_variants axis. No runtime code uses it.
drop view if exists public.market_snapshot;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'listing_observations'
      and column_name = 'card_variant_id'
  ) then
    execute 'alter table public.listing_observations drop column if exists card_variant_id';
  end if;
end
$$;

drop table if exists public.card_variants;
drop table if exists public.cards;

-- Post-drop note: after this migration, canonical_slug + printing_id is the
-- only supported runtime identity axis.
