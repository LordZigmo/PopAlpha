-- 20260419210000_insert_provider_raw_payload.sql
--
-- Adds insert_provider_raw_payload(...) RPC that properly handles the
-- partial unique index on (request_hash, response_hash).
--
-- Background: the base table has
--   CREATE UNIQUE INDEX provider_raw_payloads_request_response_uidx
--     ON provider_raw_payloads (request_hash, response_hash)
--     WHERE request_hash IS NOT NULL AND response_hash IS NOT NULL;
--
-- PostgREST's .upsert(..., { onConflict: "request_hash,response_hash" })
-- doesn't support passing the partial index predicate, so at the HTTP
-- layer Postgres responds "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification" (see incident with commit
-- 4b3b846 which caused 9h of pipeline downtime on 2026-04-17).
--
-- Inside a SQL function we CAN include the index predicate in the
-- ON CONFLICT clause. That's what this RPC does: atomic INSERT with
-- proper partial-index-aware conflict handling, no error raised, no
-- transaction rollback, no log spam.
--
-- Before this RPC, the ingest code used INSERT + catch-duplicate-error,
-- which worked but filled Postgres logs with a continuous stream of
-- "duplicate key value violates unique constraint" ERROR entries that
-- showed up as a firehose in pg_log diagnostics.

create or replace function public.insert_provider_raw_payload(
  p_provider        text,
  p_endpoint        text,
  p_params          jsonb,
  p_response        jsonb,
  p_status_code     int,
  p_fetched_at      timestamptz,
  p_request_hash    text,
  p_response_hash   text,
  p_canonical_slug  text default null,
  p_variant_ref     text default null
)
returns jsonb
language plpgsql
security definer
set statement_timeout = '30s'
set search_path = public
as $$
declare
  _id uuid;
begin
  insert into public.provider_raw_payloads (
    provider,
    endpoint,
    params,
    response,
    status_code,
    fetched_at,
    request_hash,
    response_hash,
    canonical_slug,
    variant_ref
  ) values (
    p_provider,
    p_endpoint,
    p_params,
    p_response,
    p_status_code,
    p_fetched_at,
    p_request_hash,
    p_response_hash,
    p_canonical_slug,
    p_variant_ref
  )
  on conflict (request_hash, response_hash)
    where request_hash is not null and response_hash is not null
  do nothing
  returning id into _id;

  return jsonb_build_object(
    'inserted',  _id is not null,
    'duplicate', _id is null,
    'id',        _id
  );
end;
$$;

revoke all on function public.insert_provider_raw_payload(
  text, text, jsonb, jsonb, int, timestamptz, text, text, text, text
) from public, anon, authenticated;
