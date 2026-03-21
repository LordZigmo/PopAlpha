-- Stage 1 raw-payload retention support: preserve narrow request lineage even
-- after the large JSON payload row is deleted.

create table if not exists public.provider_raw_payload_lineages (
  id                      uuid        primary key default gen_random_uuid(),
  provider_raw_payload_id uuid        unique null references public.provider_raw_payloads(id) on delete set null,
  provider                text        not null,
  endpoint                text        not null,
  params                  jsonb       null,
  request_hash            text        null,
  response_hash           text        null,
  canonical_slug          text        null references public.canonical_cards(slug) on delete set null,
  variant_ref             text        null,
  status_code             integer     not null,
  fetched_at              timestamptz not null,
  metadata                jsonb       not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists provider_raw_payload_lineages_provider_fetched_idx
  on public.provider_raw_payload_lineages (provider, fetched_at desc);

create index if not exists provider_raw_payload_lineages_hash_idx
  on public.provider_raw_payload_lineages (request_hash, response_hash, fetched_at desc)
  where request_hash is not null
     or response_hash is not null;

create or replace function public.provider_raw_payload_lineages_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_provider_raw_payload_lineages_set_updated_at on public.provider_raw_payload_lineages;

create trigger trg_provider_raw_payload_lineages_set_updated_at
before update on public.provider_raw_payload_lineages
for each row execute function public.provider_raw_payload_lineages_set_updated_at();

create or replace function public.ensure_provider_raw_payload_lineage(p_provider_raw_payload_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_lineage_id uuid;
begin
  if p_provider_raw_payload_id is null then
    return null;
  end if;

  select l.id
  into v_lineage_id
  from public.provider_raw_payload_lineages l
  where l.provider_raw_payload_id = p_provider_raw_payload_id;

  if v_lineage_id is not null then
    return v_lineage_id;
  end if;

  insert into public.provider_raw_payload_lineages (
    provider_raw_payload_id,
    provider,
    endpoint,
    params,
    request_hash,
    response_hash,
    canonical_slug,
    variant_ref,
    status_code,
    fetched_at
  )
  select
    p.id,
    p.provider,
    p.endpoint,
    p.params,
    p.request_hash,
    p.response_hash,
    p.canonical_slug,
    p.variant_ref,
    p.status_code,
    p.fetched_at
  from public.provider_raw_payloads p
  where p.id = p_provider_raw_payload_id
  on conflict (provider_raw_payload_id) do update
  set
    provider = excluded.provider,
    endpoint = excluded.endpoint,
    params = excluded.params,
    request_hash = excluded.request_hash,
    response_hash = excluded.response_hash,
    canonical_slug = excluded.canonical_slug,
    variant_ref = excluded.variant_ref,
    status_code = excluded.status_code,
    fetched_at = excluded.fetched_at,
    updated_at = now()
  returning id into v_lineage_id;

  if v_lineage_id is null then
    raise exception 'provider_raw_payload % not found; cannot materialize lineage', p_provider_raw_payload_id;
  end if;

  return v_lineage_id;
end;
$$;
