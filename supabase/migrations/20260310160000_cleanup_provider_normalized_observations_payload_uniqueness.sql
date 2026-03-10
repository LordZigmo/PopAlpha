create index if not exists provider_normalized_observations_payload_id_idx
  on public.provider_normalized_observations (provider_raw_payload_id)
  where provider_raw_payload_id is not null;

drop index if exists public.provider_normalized_observations_payload_variant_uidx;
