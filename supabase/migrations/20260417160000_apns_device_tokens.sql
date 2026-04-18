-- 20260417160000_apns_device_tokens.sql
--
-- Stores Apple Push Notification service (APNs) device tokens per
-- signed-in user. The existing `push_subscriptions` table is
-- browser-only (Web Push / VAPID); native iOS push runs on a
-- completely different protocol (HTTP/2 to api.push.apple.com) and
-- needs its own table shape.
--
-- Each row represents one device registration. A user can have many
-- (iPhone + iPad, dev + prod builds, etc). Tokens rotate on reinstall,
-- iOS restore, and iCloud device transfer — writes use upsert on
-- (clerk_user_id, device_token) so rotations replace transparently.
--
-- RLS mirrors push_subscriptions: owner-only SELECT / INSERT / UPDATE /
-- DELETE, keyed off the Clerk JWT via requesting_clerk_user_id().
-- The server APNs sender runs under the admin client so it can read
-- across users — that path bypasses RLS intentionally.

create table if not exists public.apns_device_tokens (
  id bigint generated always as identity primary key,
  clerk_user_id text not null,
  device_token text not null,
  bundle_id text not null,
  -- "development" (sandbox APNs) vs "production" (api.push.apple.com).
  -- Lets the server pick the right APNs host per row without guessing.
  environment text not null check (environment in ('development', 'production')),
  device_model text null,
  os_version text null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  -- One device ↔ one user. Reinstalls / token rotations upsert
  -- against this key so we never end up with duplicates for a device.
  constraint apns_device_tokens_user_token_key unique (clerk_user_id, device_token)
);

create index if not exists idx_apns_device_tokens_clerk_user_id
  on public.apns_device_tokens (clerk_user_id);

create index if not exists idx_apns_device_tokens_enabled
  on public.apns_device_tokens (clerk_user_id, enabled)
  where enabled = true;

-- updated_at auto-bump, mirroring the repo convention used by
-- fx_rates and personalization_profiles.
create or replace function public.apns_device_tokens_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_apns_device_tokens_set_updated_at on public.apns_device_tokens;
create trigger trg_apns_device_tokens_set_updated_at
  before update on public.apns_device_tokens
  for each row execute function public.apns_device_tokens_set_updated_at();

-- RLS — owner-only policies keyed on Clerk JWT. Admin client
-- (service_role) bypasses RLS so background senders can read across
-- users; this is identical to how push_subscriptions is treated.
alter table public.apns_device_tokens enable row level security;

drop policy if exists apns_device_tokens_owner_select on public.apns_device_tokens;
drop policy if exists apns_device_tokens_owner_insert on public.apns_device_tokens;
drop policy if exists apns_device_tokens_owner_update on public.apns_device_tokens;
drop policy if exists apns_device_tokens_owner_delete on public.apns_device_tokens;

create policy apns_device_tokens_owner_select on public.apns_device_tokens
  for select to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id());

create policy apns_device_tokens_owner_insert on public.apns_device_tokens
  for insert to authenticated
  with check (clerk_user_id = public.requesting_clerk_user_id());

create policy apns_device_tokens_owner_update on public.apns_device_tokens
  for update to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id())
  with check (clerk_user_id = public.requesting_clerk_user_id());

create policy apns_device_tokens_owner_delete on public.apns_device_tokens
  for delete to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id());

revoke all on table public.apns_device_tokens from anon, authenticated;
grant select, insert, update, delete on table public.apns_device_tokens to authenticated;
grant usage, select on sequence public.apns_device_tokens_id_seq to authenticated;
