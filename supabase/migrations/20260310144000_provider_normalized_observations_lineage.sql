-- Backfill narrow raw-payload lineage onto normalized observations so the
-- observation + match audit trail survives raw JSON retention.

alter table public.provider_normalized_observations
  add column if not exists provider_raw_payload_lineage_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_normalized_observations_provider_raw_payload_lineage_id_fkey'
      and conrelid = 'public.provider_normalized_observations'::regclass
  ) then
    alter table public.provider_normalized_observations
      add constraint provider_normalized_observations_provider_raw_payload_lineage_id_fkey
      foreign key (provider_raw_payload_lineage_id)
      references public.provider_raw_payload_lineages(id);
  end if;
end;
$$;

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
  fetched_at,
  metadata
)
select distinct
  p.id,
  p.provider,
  p.endpoint,
  p.params,
  p.request_hash,
  p.response_hash,
  p.canonical_slug,
  p.variant_ref,
  p.status_code,
  p.fetched_at,
  jsonb_build_object('backfilled_from', 'provider_normalized_observations')
from public.provider_raw_payloads p
join public.provider_normalized_observations o
  on o.provider_raw_payload_id = p.id
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
  metadata = public.provider_raw_payload_lineages.metadata || excluded.metadata,
  updated_at = now();

update public.provider_normalized_observations o
set provider_raw_payload_lineage_id = l.id
from public.provider_raw_payload_lineages l
where o.provider_raw_payload_id = l.provider_raw_payload_id
  and o.provider_raw_payload_lineage_id is distinct from l.id;

create or replace function public.provider_normalized_observations_sync_lineage()
returns trigger
language plpgsql
as $$
begin
  if new.provider_raw_payload_id is not null then
    new.provider_raw_payload_lineage_id := public.ensure_provider_raw_payload_lineage(new.provider_raw_payload_id);
  elsif new.provider_raw_payload_lineage_id is null then
    raise exception 'provider_normalized_observations requires provider_raw_payload_id or provider_raw_payload_lineage_id';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_provider_normalized_observations_sync_lineage on public.provider_normalized_observations;

create trigger trg_provider_normalized_observations_sync_lineage
before insert or update of provider_raw_payload_id, provider_raw_payload_lineage_id
on public.provider_normalized_observations
for each row execute function public.provider_normalized_observations_sync_lineage();

do $$
begin
  if exists (
    select 1
    from public.provider_normalized_observations
    where provider_raw_payload_lineage_id is null
  ) then
    raise exception 'provider_normalized_observations still has null provider_raw_payload_lineage_id values after lineage backfill';
  end if;
end;
$$;

alter table public.provider_normalized_observations
  alter column provider_raw_payload_lineage_id set not null;

create unique index if not exists provider_normalized_observations_lineage_variant_uidx
  on public.provider_normalized_observations (provider_raw_payload_lineage_id, provider_card_id, provider_variant_id);
