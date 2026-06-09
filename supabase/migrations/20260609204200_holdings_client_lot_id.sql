-- 20260609204200_holdings_client_lot_id.sql
--
-- Idempotency key for holdings inserts (post-launch ticket C2 from the
-- launch audit). The bulk multi-scan import retries chunks whose POST
-- failed ambiguously — a timeout or lost response can arrive AFTER the
-- server committed, and without a server-side identity for "this exact
-- client-side lot" a retry inserts duplicates. The iOS client already
-- carries a stable UUID per tray entry (MultiScanEntry.id); this column
-- lets the server recognize a resubmission of the same entry and ignore
-- it.
--
-- Why NOT a uniqueness constraint on (owner, slug, printing, grade):
-- multiple legitimate lots share that key (two copies bought on
-- different days). The client-generated UUID is the only correct
-- identity for "the same insert attempt".
--
-- Existing rows and inserts that omit the column get gen_random_uuid()
-- via the default, so they can never collide with a client-supplied
-- key and no backfill pass is needed. The unique constraint is
-- owner-scoped so one user's key can never collide with (or probe for)
-- another's.
--
-- The bulk-import route upserts with
-- on_conflict=(owner_clerk_id, client_lot_id) + ignore-duplicates, so
-- a retried already-committed chunk no-ops with inserted=0 instead of
-- duplicating. PostgREST conflict inference requires a full (not
-- partial) unique index — hence NOT NULL + default rather than a
-- nullable column with a partial index.

alter table public.holdings
  add column if not exists client_lot_id uuid not null default gen_random_uuid();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'holdings_owner_client_lot_id_key'
  ) then
    alter table public.holdings
      add constraint holdings_owner_client_lot_id_key
      unique (owner_clerk_id, client_lot_id);
  end if;
end
$$;
