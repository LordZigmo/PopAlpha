-- 20260508160000_apple_subscriptions_trial_expiring_notified.sql
--
-- Adds a "we sent the ~24h-before-trial-expires push" stamp to
-- apple_subscriptions so the notify-trial-expiring cron doesn't
-- double-fire.
--
-- The cron's claim filter is:
--   status='active' AND expires_at BETWEEN now()+23h AND now()+25h
--   AND trial_expiring_notified_at IS NULL
-- The wider 23-25h window absorbs missed cron runs without
-- silently swallowing notifications.

ALTER TABLE public.apple_subscriptions
  ADD COLUMN IF NOT EXISTS trial_expiring_notified_at timestamptz;

-- Partial index for the cron's exact claim shape — keeps it tiny
-- (only un-notified active subs) and avoids touching the existing
-- apple_subscriptions_user_active_idx used by hasPro().
CREATE INDEX IF NOT EXISTS apple_subscriptions_trial_expiry_window_idx
  ON public.apple_subscriptions (expires_at)
  WHERE status = 'active' AND trial_expiring_notified_at IS NULL;
