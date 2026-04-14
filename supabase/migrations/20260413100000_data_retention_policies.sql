-- Data retention: chunked pruning for append-only tables that grow without
-- bounds.  Called nightly by /api/cron/prune-old-data.
--
-- Each table gets its own DELETE … WHERE … LIMIT so we never hold a long
-- transaction lock.  The function returns a JSON summary so the cron
-- endpoint can log what happened.

create or replace function public.prune_old_data()
returns jsonb
language plpgsql
security definer
set statement_timeout = '120s'
as $$
declare
  _chunk_limit  int := 1000;
  _deleted      int;
  _result       jsonb := '{}'::jsonb;
begin
  -- 1. provider_raw_payloads — 14-day retention
  delete from public.provider_raw_payloads
  where  id in (
    select id from public.provider_raw_payloads
    where  fetched_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_raw_payloads', _deleted);

  -- 2. provider_ingests — 30-day retention
  delete from public.provider_ingests
  where  id in (
    select id from public.provider_ingests
    where  created_at < now() - interval '30 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_ingests', _deleted);

  -- 3. provider_normalized_observations — 14-day retention
  delete from public.provider_normalized_observations
  where  id in (
    select id from public.provider_normalized_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('provider_normalized_observations', _deleted);

  -- 4. listing_observations — 14-day retention
  delete from public.listing_observations
  where  id in (
    select id from public.listing_observations
    where  observed_at < now() - interval '14 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('listing_observations', _deleted);

  -- 5. card_page_views — 90-day retention
  delete from public.card_page_views
  where  id in (
    select id from public.card_page_views
    where  viewed_at < now() - interval '90 days'
    limit  _chunk_limit
  );
  get diagnostics _deleted = row_count;
  _result := _result || jsonb_build_object('card_page_views', _deleted);

  return _result;
end;
$$;

-- Only service_role should call this (via cron endpoint).
revoke all on function public.prune_old_data() from public, anon, authenticated;
