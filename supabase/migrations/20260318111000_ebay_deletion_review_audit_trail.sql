alter table public.ebay_deletion_manual_review_tasks
  add column if not exists candidate_match_clerk_user_id text,
  add column if not exists candidate_match_handle text,
  add column if not exists candidate_match_handle_norm text,
  add column if not exists candidate_match_reason text,
  add column if not exists candidate_match_marked_at timestamptz,
  add column if not exists candidate_match_marked_by text;

create table if not exists public.ebay_deletion_manual_review_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ebay_deletion_manual_review_tasks(id),
  actor_identifier text not null,
  event_type text not null
    check (
      event_type in (
        'review_state_changed',
        'review_note_added',
        'review_note_cleared',
        'candidate_match_marked',
        'candidate_match_cleared',
        'escalated'
      )
    ),
  prior_review_state text null
    check (
      prior_review_state is null
      or prior_review_state in (
        'pending_review',
        'needs_more_context',
        'matched_candidate',
        'no_match_found',
        'escalated'
      )
    ),
  new_review_state text null
    check (
      new_review_state is null
      or new_review_state in (
        'pending_review',
        'needs_more_context',
        'matched_candidate',
        'no_match_found',
        'escalated'
      )
    ),
  note_payload text null,
  candidate_match_clerk_user_id text null,
  candidate_match_handle text null,
  candidate_match_handle_norm text null,
  candidate_match_reason text null,
  created_at timestamptz not null default now()
);

create index if not exists ebay_deletion_manual_review_events_task_created_idx
  on public.ebay_deletion_manual_review_events (task_id, created_at desc);

alter table public.ebay_deletion_manual_review_events enable row level security;

revoke all on table public.ebay_deletion_manual_review_events from public, anon, authenticated;

create or replace function public.apply_ebay_deletion_manual_review_update(
  p_task_id uuid,
  p_actor_identifier text,
  p_review_state text default null,
  p_set_review_notes boolean default false,
  p_review_notes text default null,
  p_candidate_match_clerk_user_id text default null,
  p_candidate_match_handle text default null,
  p_candidate_match_handle_norm text default null,
  p_candidate_match_reason text default null,
  p_clear_candidate_match boolean default false
)
returns setof public.ebay_deletion_manual_review_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ebay_deletion_manual_review_tasks%rowtype;
  v_updated public.ebay_deletion_manual_review_tasks%rowtype;
  v_actor_identifier text;
  v_new_review_state text;
  v_now timestamptz := now();
  v_state_changed boolean := false;
  v_note_changed boolean := false;
  v_candidate_changed boolean := false;
  v_clearing_candidate boolean := coalesce(p_clear_candidate_match, false);
  v_has_candidate_payload boolean := nullif(trim(coalesce(p_candidate_match_clerk_user_id, '')), '') is not null;
begin
  v_actor_identifier := nullif(trim(coalesce(p_actor_identifier, '')), '');
  if v_actor_identifier is null then
    raise exception 'p_actor_identifier is required.';
  end if;

  if p_review_state is not null and p_review_state not in (
    'pending_review',
    'needs_more_context',
    'matched_candidate',
    'no_match_found',
    'escalated'
  ) then
    raise exception 'p_review_state must be a valid manual review state.';
  end if;

  if v_has_candidate_payload then
    if nullif(trim(coalesce(p_candidate_match_handle, '')), '') is null
      or nullif(trim(coalesce(p_candidate_match_handle_norm, '')), '') is null
      or nullif(trim(coalesce(p_candidate_match_reason, '')), '') is null then
      raise exception 'candidate match updates require clerk_user_id, handle, handle_norm, and reason.';
    end if;
  end if;

  select *
  into v_existing
  from public.ebay_deletion_manual_review_tasks
  where id = p_task_id
  for update;

  if not found then
    return;
  end if;

  v_new_review_state := coalesce(p_review_state, v_existing.review_state);
  v_state_changed := p_review_state is not null and p_review_state is distinct from v_existing.review_state;
  v_note_changed := coalesce(p_set_review_notes, false)
    and coalesce(v_existing.review_notes, '') is distinct from coalesce(p_review_notes, '');

  v_candidate_changed := (
    v_clearing_candidate
    and (
      v_existing.candidate_match_clerk_user_id is not null
      or v_existing.candidate_match_handle is not null
      or v_existing.candidate_match_handle_norm is not null
    )
  ) or (
    v_has_candidate_payload
    and (
      p_candidate_match_clerk_user_id is distinct from v_existing.candidate_match_clerk_user_id
      or p_candidate_match_handle is distinct from v_existing.candidate_match_handle
      or p_candidate_match_handle_norm is distinct from v_existing.candidate_match_handle_norm
      or p_candidate_match_reason is distinct from v_existing.candidate_match_reason
    )
  );

  update public.ebay_deletion_manual_review_tasks
  set
    review_state = v_new_review_state,
    review_status = case v_new_review_state
      when 'matched_candidate' then 'REVIEWED'
      when 'no_match_found' then 'DISMISSED'
      else 'OPEN'
    end,
    review_notes = case
      when coalesce(p_set_review_notes, false) then p_review_notes
      else review_notes
    end,
    review_state_updated_at = case
      when v_state_changed then v_now
      else review_state_updated_at
    end,
    review_state_updated_by = case
      when v_state_changed then v_actor_identifier
      else review_state_updated_by
    end,
    candidate_match_clerk_user_id = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then p_candidate_match_clerk_user_id
      else candidate_match_clerk_user_id
    end,
    candidate_match_handle = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then p_candidate_match_handle
      else candidate_match_handle
    end,
    candidate_match_handle_norm = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then p_candidate_match_handle_norm
      else candidate_match_handle_norm
    end,
    candidate_match_reason = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then p_candidate_match_reason
      else candidate_match_reason
    end,
    candidate_match_marked_at = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then v_now
      else candidate_match_marked_at
    end,
    candidate_match_marked_by = case
      when v_clearing_candidate then null
      when v_has_candidate_payload then v_actor_identifier
      else candidate_match_marked_by
    end,
    reviewed_at = case
      when v_state_changed or v_note_changed or v_candidate_changed then v_now
      else reviewed_at
    end
  where id = p_task_id
  returning *
  into v_updated;

  if v_state_changed then
    insert into public.ebay_deletion_manual_review_events (
      task_id,
      actor_identifier,
      event_type,
      prior_review_state,
      new_review_state
    )
    values (
      v_updated.id,
      v_actor_identifier,
      'review_state_changed',
      v_existing.review_state,
      v_updated.review_state
    );

    if v_updated.review_state = 'escalated' then
      insert into public.ebay_deletion_manual_review_events (
        task_id,
        actor_identifier,
        event_type,
        prior_review_state,
        new_review_state
      )
      values (
        v_updated.id,
        v_actor_identifier,
        'escalated',
        v_existing.review_state,
        v_updated.review_state
      );
    end if;
  end if;

  if v_note_changed then
    insert into public.ebay_deletion_manual_review_events (
      task_id,
      actor_identifier,
      event_type,
      prior_review_state,
      new_review_state,
      note_payload
    )
    values (
      v_updated.id,
      v_actor_identifier,
      case when v_updated.review_notes is null then 'review_note_cleared' else 'review_note_added' end,
      v_existing.review_state,
      v_updated.review_state,
      left(v_updated.review_notes, 4000)
    );
  end if;

  if v_candidate_changed then
    if v_clearing_candidate then
      insert into public.ebay_deletion_manual_review_events (
        task_id,
        actor_identifier,
        event_type,
        prior_review_state,
        new_review_state,
        candidate_match_clerk_user_id,
        candidate_match_handle,
        candidate_match_handle_norm,
        candidate_match_reason
      )
      values (
        v_updated.id,
        v_actor_identifier,
        'candidate_match_cleared',
        v_existing.review_state,
        v_updated.review_state,
        v_existing.candidate_match_clerk_user_id,
        v_existing.candidate_match_handle,
        v_existing.candidate_match_handle_norm,
        v_existing.candidate_match_reason
      );
    elsif v_has_candidate_payload then
      insert into public.ebay_deletion_manual_review_events (
        task_id,
        actor_identifier,
        event_type,
        prior_review_state,
        new_review_state,
        candidate_match_clerk_user_id,
        candidate_match_handle,
        candidate_match_handle_norm,
        candidate_match_reason
      )
      values (
        v_updated.id,
        v_actor_identifier,
        'candidate_match_marked',
        v_existing.review_state,
        v_updated.review_state,
        v_updated.candidate_match_clerk_user_id,
        v_updated.candidate_match_handle,
        v_updated.candidate_match_handle_norm,
        v_updated.candidate_match_reason
      );
    end if;
  end if;

  return query
  select v_updated.*;
end;
$$;

revoke all on function public.apply_ebay_deletion_manual_review_update(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  text,
  text,
  text,
  boolean
) from public, anon, authenticated;

grant execute on function public.apply_ebay_deletion_manual_review_update(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  text,
  text,
  text,
  boolean
) to service_role;
