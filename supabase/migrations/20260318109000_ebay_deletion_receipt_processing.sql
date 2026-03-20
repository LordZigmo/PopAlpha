alter table public.ebay_deletion_notification_receipts
  alter column processing_status set default 'received';

update public.ebay_deletion_notification_receipts
set processing_status = 'received'
where processing_status = 'pending';

update public.ebay_deletion_notification_receipts
set processing_status = 'processed'
where processing_status = 'ignored';

alter table public.ebay_deletion_notification_receipts
  drop constraint if exists ebay_deletion_notification_receipts_processing_status_check;

alter table public.ebay_deletion_notification_receipts
  add constraint ebay_deletion_notification_receipts_processing_status_check
  check (processing_status in ('received', 'processing', 'processed', 'failed'));

alter table public.ebay_deletion_notification_receipts
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempted_at timestamptz null,
  add column if not exists processing_started_at timestamptz null,
  add column if not exists failed_at timestamptz null,
  add column if not exists processing_worker text null,
  add column if not exists last_error_code text null,
  add column if not exists last_error_summary text null,
  add column if not exists processing_outcome text null;

alter table public.ebay_deletion_notification_receipts
  drop constraint if exists ebay_deletion_notification_receipts_processing_outcome_check;

alter table public.ebay_deletion_notification_receipts
  add constraint ebay_deletion_notification_receipts_processing_outcome_check
  check (
    processing_outcome is null
    or processing_outcome in ('manual_review_task_created', 'manual_review_task_existing')
  );

create index if not exists ebay_deletion_receipts_claim_idx
  on public.ebay_deletion_notification_receipts (processing_status, received_at asc, attempt_count asc)
  where processing_status in ('received', 'failed');

create index if not exists ebay_deletion_receipts_processing_started_idx
  on public.ebay_deletion_notification_receipts (processing_status, processing_started_at asc)
  where processing_status = 'processing';

create table if not exists public.ebay_deletion_manual_review_tasks (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.ebay_deletion_notification_receipts(id) on delete cascade,
  notification_id text not null unique,
  topic text not null,
  event_date timestamptz not null,
  publish_date timestamptz not null,
  ebay_user_id text not null,
  ebay_username text null,
  review_status text not null default 'OPEN'
    check (review_status in ('OPEN', 'REVIEWED', 'DISMISSED')),
  review_notes text null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz null
);

create index if not exists ebay_deletion_manual_review_tasks_review_status_idx
  on public.ebay_deletion_manual_review_tasks (review_status, created_at desc);

alter table public.ebay_deletion_manual_review_tasks enable row level security;

revoke all on table public.ebay_deletion_manual_review_tasks from public, anon, authenticated;

create or replace function public.claim_ebay_deletion_notification_receipts(
  p_worker text default null,
  p_batch_size integer default 10,
  p_max_attempts integer default 5,
  p_stale_after_seconds integer default 1800
)
returns setof public.ebay_deletion_notification_receipts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker text;
  v_batch_size integer;
  v_max_attempts integer;
  v_stale_after_seconds integer;
begin
  v_worker := coalesce(nullif(trim(p_worker), ''), 'worker');
  v_batch_size := greatest(1, least(coalesce(p_batch_size, 10), 25));
  v_max_attempts := greatest(1, least(coalesce(p_max_attempts, 5), 20));
  v_stale_after_seconds := greatest(60, coalesce(p_stale_after_seconds, 1800));

  update public.ebay_deletion_notification_receipts
  set
    processing_status = 'failed',
    processing_worker = null,
    failed_at = now(),
    last_error_code = 'STALE_CLAIM',
    last_error_summary = left(
      coalesce(last_error_summary || E'\n', '')
      || '[auto-recovered] stale processing receipt reclaimed by claim_ebay_deletion_notification_receipts',
      8000
    )
  where processing_status = 'processing'
    and coalesce(processing_started_at, last_attempted_at, received_at)
      <= now() - make_interval(secs => v_stale_after_seconds);

  return query
  with claimable as (
    select r.id
    from public.ebay_deletion_notification_receipts r
    where (
      r.processing_status = 'received'
      or (r.processing_status = 'failed' and r.attempt_count < v_max_attempts)
    )
    order by r.received_at asc, r.notification_id asc
    for update skip locked
    limit v_batch_size
  )
  update public.ebay_deletion_notification_receipts r
  set
    processing_status = 'processing',
    attempt_count = r.attempt_count + 1,
    last_attempted_at = now(),
    processing_started_at = now(),
    processing_worker = v_worker,
    failed_at = null,
    last_error_code = null,
    last_error_summary = null
  from claimable
  where r.id = claimable.id
  returning r.*;
end;
$$;

revoke all on function public.claim_ebay_deletion_notification_receipts(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ebay_deletion_notification_receipts(text, integer, integer, integer)
  to service_role;
