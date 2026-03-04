-- Add an explicit normalized language token to staged provider observations.

alter table public.provider_normalized_observations
  add column if not exists normalized_language text not null default 'unknown';

update public.provider_normalized_observations
set normalized_language = case
  when provider_language is null or btrim(provider_language) = '' then 'unknown'
  when lower(btrim(provider_language)) = 'english' then 'en'
  when lower(btrim(provider_language)) = 'japanese' then 'jp'
  when lower(btrim(provider_language)) = 'korean' then 'kr'
  when lower(btrim(provider_language)) = 'french' then 'fr'
  when lower(btrim(provider_language)) = 'german' then 'de'
  when lower(btrim(provider_language)) = 'spanish' then 'es'
  when lower(btrim(provider_language)) = 'italian' then 'it'
  when lower(btrim(provider_language)) = 'portuguese' then 'pt'
  else regexp_replace(lower(btrim(provider_language)), '\s+', '_', 'g')
end
where normalized_language = 'unknown';
