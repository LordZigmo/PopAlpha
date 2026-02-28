-- external_listing_id was added to listing_observations outside of migrations
-- (schema drift). The column is not used by any application code — external_id
-- is the authoritative column. Drop the not-null constraint so existing inserts
-- that only provide external_id are not blocked.
alter table public.listing_observations
  alter column external_listing_id drop not null;
