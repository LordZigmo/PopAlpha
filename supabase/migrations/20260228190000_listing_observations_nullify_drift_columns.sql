-- Several columns were added directly to listing_observations in the Supabase
-- dashboard (outside migrations), all with NOT NULL constraints. This migration
-- makes them nullable so application inserts that don't provide them succeed.
-- Using a DO block so each ALTER is skipped gracefully if the column doesn't exist.

do $$
declare
  col record;
begin
  for col in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'listing_observations'
      -- application code never writes these columns; they are schema drift
      and column_name in (
        'external_listing_id',
        'price_usd',
        'grade_label',
        'grade_value',
        'source_type',
        'listing_url'
      )
      and is_nullable = 'NO'
  loop
    execute format(
      'alter table public.listing_observations alter column %I drop not null',
      col.column_name
    );
    raise notice 'Dropped not-null from listing_observations.%', col.column_name;
  end loop;
end $$;
