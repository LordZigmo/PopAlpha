-- App users table — identity layer for handles and onboarding state.
-- clerk_user_id is the PK (matches Clerk userId string).
-- handle = display form (ZigTrader), handle_norm = lowercase (zigtrader) with UNIQUE.
-- onboarding_completed_at NULL until handle is set — this is the gate flag.

CREATE TABLE IF NOT EXISTS public.app_users (
  clerk_user_id           text PRIMARY KEY,
  handle                  text,
  handle_norm             text UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  onboarding_completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS app_users_handle_norm_idx ON public.app_users (handle_norm);
