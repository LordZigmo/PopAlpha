-- Provider set-level health/state for smarter ingest planning.
-- Tracks freshness, cooldowns, retry timing, and recent run outcomes.

create table if not exists public.provider_set_health (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null,
  provider_set_id      text not null,
  canonical_set_code   text null,
  canonical_set_name   text null,
  last_attempt_at      timestamptz null,
  last_success_at      timestamptz null,
  last_429_at          timestamptz null,
  last_status_code     integer null,
  consecutive_429      integer not null default 0,
  cooldown_until       timestamptz null,
  next_retry_at        timestamptz null,
  last_error           text null,
  requests_last_run    integer not null default 0,
  pages_last_run       integer not null default 0,
  cards_last_run       integer not null default 0,
  updated_at           timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create unique index if not exists provider_set_health_provider_set_uidx
  on public.provider_set_health (provider, provider_set_id);

create index if not exists provider_set_health_provider_retry_idx
  on public.provider_set_health (provider, next_retry_at asc, updated_at desc);

create index if not exists provider_set_health_provider_freshness_idx
  on public.provider_set_health (provider, last_success_at asc nulls first, updated_at desc);
