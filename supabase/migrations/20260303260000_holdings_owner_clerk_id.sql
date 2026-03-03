-- Add owner_clerk_id column for Clerk-based identity.
-- Existing rows keep user_id (Supabase auth UUID); new rows written by
-- /api/holdings use owner_clerk_id (Clerk user ID string, e.g. "user_2abc…").

ALTER TABLE public.holdings
  ADD COLUMN IF NOT EXISTS owner_clerk_id text;

CREATE INDEX IF NOT EXISTS holdings_owner_clerk_id_idx
  ON public.holdings (owner_clerk_id);
