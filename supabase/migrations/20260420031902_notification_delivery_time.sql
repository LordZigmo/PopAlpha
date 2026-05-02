-- 20260420000000_notification_delivery_time.sql
--
-- Per-user preferred delivery time for push notifications.
--
-- hour / minute are interpreted in the user's LOCAL time. The timezone
-- column stores the IANA zone (e.g. "America/New_York") so the server
-- can compute the correct UTC moment per user when the send cron runs.
--
-- Defaults: 9:00 in UTC. iOS overwrites timezone with the real IANA
-- identifier on first save, so the "UTC" default is only a fallback
-- for brand-new rows that haven't been touched yet.

alter table public.app_users
  add column if not exists notification_delivery_hour int not null default 9,
  add column if not exists notification_delivery_minute int not null default 0,
  add column if not exists notification_delivery_timezone text not null default 'UTC';

-- Range guards. Using DO blocks so re-running the migration doesn't
-- fail on an already-present constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_users_notification_delivery_hour_range'
  ) then
    alter table public.app_users
      add constraint app_users_notification_delivery_hour_range
      check (notification_delivery_hour between 0 and 23);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'app_users_notification_delivery_minute_range'
  ) then
    alter table public.app_users
      add constraint app_users_notification_delivery_minute_range
      check (notification_delivery_minute between 0 and 59);
  end if;
end
$$;

-- No index — this column is only read per-user during settings fetch
-- and during the eventual push-delivery cron (which will scan anyway
-- to find users whose local time matches "now"). Adding an index now
-- would just cost writes.
