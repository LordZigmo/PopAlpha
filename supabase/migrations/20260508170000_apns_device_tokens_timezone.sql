-- 20260508170000_apns_device_tokens_timezone.sql
--
-- Adds an IANA timezone identifier (e.g., "America/Los_Angeles") to
-- apns_device_tokens so server-side scheduled notifications can fire
-- at a consistent local time per user (e.g., the trial-expiring
-- push goes out at 10am LOCAL, not 10am UTC).
--
-- Optional + nullable: legacy registrations from before this column
-- existed leave it null, and the cron falls back to UTC for those
-- rows. iOS will populate it on the next token re-registration.

ALTER TABLE public.apns_device_tokens
  ADD COLUMN IF NOT EXISTS timezone text;
