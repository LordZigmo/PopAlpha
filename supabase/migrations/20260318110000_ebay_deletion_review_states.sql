alter table public.ebay_deletion_manual_review_tasks
  add column if not exists review_state text,
  add column if not exists review_state_updated_at timestamptz,
  add column if not exists review_state_updated_by text;

update public.ebay_deletion_manual_review_tasks
set review_state = case review_status
  when 'REVIEWED' then 'matched_candidate'
  when 'DISMISSED' then 'no_match_found'
  else 'pending_review'
end
where review_state is null;

update public.ebay_deletion_manual_review_tasks
set review_state_updated_at = coalesce(reviewed_at, created_at, timezone('utc', now()))
where review_state_updated_at is null;

alter table public.ebay_deletion_manual_review_tasks
  alter column review_state set default 'pending_review',
  alter column review_state set not null,
  alter column review_state_updated_at set default timezone('utc', now()),
  alter column review_state_updated_at set not null;

alter table public.ebay_deletion_manual_review_tasks
  drop constraint if exists ebay_deletion_manual_review_tasks_review_state_check;

alter table public.ebay_deletion_manual_review_tasks
  add constraint ebay_deletion_manual_review_tasks_review_state_check
  check (
    review_state in (
      'pending_review',
      'needs_more_context',
      'matched_candidate',
      'no_match_found',
      'escalated'
    )
  );

create index if not exists ebay_deletion_manual_review_tasks_review_state_idx
  on public.ebay_deletion_manual_review_tasks (review_state, created_at desc);

revoke all on table public.ebay_deletion_manual_review_tasks from public, anon, authenticated;
