-- 20260421120000_holdings_source.sql
--
-- Track how a holding row was created so the iOS app can surface a
-- subtle "Imported" chip on lots added via bulk CSV import. Forward-
-- compatible enum (text + check constraint) so additional sources
-- like a scanner-captured lot or a marketplace integration just need
-- a check-constraint tweak later.
--
-- Default is 'manual' — every existing row and every future row added
-- through the normal POST /api/holdings path stays labelled manual
-- with no client changes required.

alter table public.holdings
  add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'holdings_source_check'
  ) then
    alter table public.holdings
      add constraint holdings_source_check
      check (source in ('manual', 'csv_import', 'scanner'));
  end if;
end
$$;

-- No index; the column is read per-row in the listing, not filtered on.
