-- The legacy Supabase-auth UUID owner column is no longer the canonical owner key.
-- Keep it for compatibility during rollout, but stop requiring it for new inserts.

alter table public.holdings
  alter column user_id drop not null;
