-- Allow raw JSON retention deletes to preserve normalized observations and
-- downstream match rows now that observation lineage is stored independently.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'provider_normalized_observations_provider_raw_payload_id_fkey'
      and conrelid = 'public.provider_normalized_observations'::regclass
  ) then
    alter table public.provider_normalized_observations
      drop constraint provider_normalized_observations_provider_raw_payload_id_fkey;
  end if;
end;
$$;

alter table public.provider_normalized_observations
  alter column provider_raw_payload_id drop not null;

alter table public.provider_normalized_observations
  add constraint provider_normalized_observations_provider_raw_payload_id_fkey
  foreign key (provider_raw_payload_id)
  references public.provider_raw_payloads(id)
  on delete set null;
