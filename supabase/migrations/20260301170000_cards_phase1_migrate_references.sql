-- Phase 1 of retiring public.cards:
-- add canonical_slug / printing_id to downstream tables, preserve legacy
-- columns, and backfill only from stable relations.

do $$
begin
  if to_regclass('public.holdings') is not null then
    execute 'alter table public.holdings add column if not exists canonical_slug text null';
    execute 'alter table public.holdings add column if not exists printing_id uuid null';
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'holdings'
        and column_name = 'card_id'
        and is_nullable = 'NO'
    ) then
      execute 'alter table public.holdings alter column card_id drop not null';
    end if;
  end if;
end
$$;

do $$
begin
  if to_regclass('public.market_latest') is not null then
    execute 'alter table public.market_latest add column if not exists canonical_slug text null';
    execute 'alter table public.market_latest add column if not exists printing_id uuid null';
  end if;
end
$$;

do $$
begin
  if to_regclass('public.market_observations') is not null then
    execute 'alter table public.market_observations add column if not exists canonical_slug text null';
    execute 'alter table public.market_observations add column if not exists printing_id uuid null';
  end if;
end
$$;

do $$
begin
  if to_regclass('public.market_snapshots') is not null then
    execute 'alter table public.market_snapshots add column if not exists canonical_slug text null';
    execute 'alter table public.market_snapshots add column if not exists printing_id uuid null';
  end if;
end
$$;

do $$
begin
  if to_regclass('public.listing_observations') is not null then
    execute 'alter table public.listing_observations add column if not exists canonical_slug text null';
    execute 'alter table public.listing_observations add column if not exists printing_id uuid null';
  end if;
end
$$;

do $$
begin
  if to_regclass('public.card_external_mappings') is not null then
    execute 'alter table public.card_external_mappings add column if not exists canonical_slug text null';
    execute 'alter table public.card_external_mappings add column if not exists printing_id uuid null';
  end if;
end
$$;

do $$
begin
  if to_regclass('public.holdings') is not null and not exists (
    select 1 from pg_constraint where conname = 'holdings_canonical_slug_fkey'
  ) then
    execute 'alter table public.holdings add constraint holdings_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.holdings') is not null and not exists (
    select 1 from pg_constraint where conname = 'holdings_printing_id_fkey'
  ) then
    execute 'alter table public.holdings add constraint holdings_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

  if to_regclass('public.market_latest') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_latest_canonical_slug_fkey'
  ) then
    execute 'alter table public.market_latest add constraint market_latest_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.market_latest') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_latest_printing_id_fkey'
  ) then
    execute 'alter table public.market_latest add constraint market_latest_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

  if to_regclass('public.market_observations') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_observations_canonical_slug_fkey'
  ) then
    execute 'alter table public.market_observations add constraint market_observations_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.market_observations') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_observations_printing_id_fkey'
  ) then
    execute 'alter table public.market_observations add constraint market_observations_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

  if to_regclass('public.market_snapshots') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_snapshots_canonical_slug_fkey'
  ) then
    execute 'alter table public.market_snapshots add constraint market_snapshots_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.market_snapshots') is not null and not exists (
    select 1 from pg_constraint where conname = 'market_snapshots_printing_id_fkey'
  ) then
    execute 'alter table public.market_snapshots add constraint market_snapshots_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

  if to_regclass('public.listing_observations') is not null and not exists (
    select 1 from pg_constraint where conname = 'listing_observations_canonical_slug_fkey'
  ) then
    execute 'alter table public.listing_observations add constraint listing_observations_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.listing_observations') is not null and not exists (
    select 1 from pg_constraint where conname = 'listing_observations_printing_id_fkey'
  ) then
    execute 'alter table public.listing_observations add constraint listing_observations_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

  if to_regclass('public.card_external_mappings') is not null and not exists (
    select 1 from pg_constraint where conname = 'card_external_mappings_canonical_slug_fkey'
  ) then
    execute 'alter table public.card_external_mappings add constraint card_external_mappings_canonical_slug_fkey foreign key (canonical_slug) references public.canonical_cards(slug) on delete set null';
  end if;

  if to_regclass('public.card_external_mappings') is not null and not exists (
    select 1 from pg_constraint where conname = 'card_external_mappings_printing_id_fkey'
  ) then
    execute 'alter table public.card_external_mappings add constraint card_external_mappings_printing_id_fkey foreign key (printing_id) references public.card_printings(id) on delete set null';
  end if;

end
$$;

do $$
begin
  if to_regclass('public.holdings') is not null then
    execute 'create index if not exists holdings_canonical_slug_idx on public.holdings (canonical_slug)';
    execute 'create index if not exists holdings_printing_id_idx on public.holdings (printing_id)';
  end if;

  if to_regclass('public.market_latest') is not null then
    execute 'create index if not exists market_latest_canonical_slug_idx on public.market_latest (canonical_slug)';
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'market_latest'
        and column_name in ('source', 'grade', 'price_type')
      group by table_name
      having count(*) = 3
    ) then
      execute 'create index if not exists market_latest_printing_idx on public.market_latest (printing_id, source, grade, price_type)';
      execute '' ||
        'create unique index if not exists market_latest_printing_source_grade_price_type_uidx ' ||
        'on public.market_latest (printing_id, source, grade, price_type) ' ||
        'where printing_id is not null';
    end if;
  end if;

  if to_regclass('public.market_observations') is not null then
    execute 'create index if not exists market_observations_canonical_slug_idx on public.market_observations (canonical_slug)';
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'market_observations'
        and column_name in ('source', 'grade', 'price_type', 'observed_at')
      group by table_name
      having count(*) = 4
    ) then
      execute 'create index if not exists market_observations_printing_idx on public.market_observations (printing_id, source, grade, price_type, observed_at desc)';
    end if;
  end if;

  if to_regclass('public.market_snapshots') is not null then
    execute 'create index if not exists market_snapshots_canonical_slug_idx on public.market_snapshots (canonical_slug)';
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'market_snapshots'
        and column_name in ('source', 'grade', 'updated_at')
      group by table_name
      having count(*) = 3
    ) then
      execute 'create index if not exists market_snapshots_printing_idx on public.market_snapshots (printing_id, source, grade, updated_at desc)';
    end if;
  end if;

  if to_regclass('public.listing_observations') is not null then
    execute 'create index if not exists listing_observations_canonical_slug_lookup_idx on public.listing_observations (canonical_slug)';
    execute 'create index if not exists listing_observations_printing_id_lookup_idx on public.listing_observations (printing_id)';
  end if;

  if to_regclass('public.card_external_mappings') is not null then
    execute 'create index if not exists card_external_mappings_canonical_slug_idx on public.card_external_mappings (canonical_slug)';
    execute 'create index if not exists card_external_mappings_printing_id_idx on public.card_external_mappings (printing_id)';
  end if;

end
$$;

do $$
begin
  if to_regclass('public.holdings') is not null then
    execute $sql$
      update public.holdings h
      set canonical_slug = c.canonical_slug
      from public.cards c
      where h.card_id = c.id
        and h.canonical_slug is null
        and c.canonical_slug is not null
    $sql$;
  end if;

  if to_regclass('public.market_latest') is not null then
    execute $sql$
      update public.market_latest m
      set canonical_slug = c.canonical_slug
      from public.cards c
      where m.card_id = c.id
        and m.canonical_slug is null
        and c.canonical_slug is not null
    $sql$;
  end if;

  if to_regclass('public.market_observations') is not null then
    execute $sql$
      update public.market_observations m
      set canonical_slug = c.canonical_slug
      from public.cards c
      where m.card_id = c.id
        and m.canonical_slug is null
        and c.canonical_slug is not null
    $sql$;
  end if;

  if to_regclass('public.market_snapshots') is not null then
    execute $sql$
      update public.market_snapshots m
      set canonical_slug = c.canonical_slug
      from public.cards c
      where m.card_id = c.id
        and m.canonical_slug is null
        and c.canonical_slug is not null
    $sql$;
  end if;

  if to_regclass('public.card_external_mappings') is not null then
    execute $sql$
      update public.card_external_mappings cem
      set canonical_slug = c.canonical_slug
      from public.cards c
      where cem.card_id = c.id
        and cem.canonical_slug is null
        and c.canonical_slug is not null
    $sql$;
  end if;

end
$$;
