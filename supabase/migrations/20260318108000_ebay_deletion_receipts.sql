create table if not exists public.ebay_deletion_notification_receipts (
  id uuid primary key default gen_random_uuid(),
  notification_id text not null unique,
  topic text not null,
  schema_version text not null,
  event_date timestamptz not null,
  publish_date timestamptz not null,
  publish_attempt_count integer not null check (publish_attempt_count > 0),
  payload jsonb not null,
  payload_sha256 text not null,
  signature_alg text not null,
  signature_digest text not null,
  signature_kid text not null,
  verification_key_alg text not null,
  verification_key_digest text not null,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processed', 'ignored', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists ebay_deletion_notification_receipts_received_at_idx
  on public.ebay_deletion_notification_receipts (received_at desc);

create index if not exists ebay_deletion_notification_receipts_processing_status_idx
  on public.ebay_deletion_notification_receipts (processing_status, received_at desc);

alter table public.ebay_deletion_notification_receipts enable row level security;

revoke all on table public.ebay_deletion_notification_receipts from public, anon, authenticated;
