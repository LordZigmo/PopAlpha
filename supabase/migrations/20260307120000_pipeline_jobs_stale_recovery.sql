-- Reclaim stale RUNNING pipeline jobs during claim to avoid queue deadlock.

drop function if exists public.claim_pipeline_job(text);

create or replace function public.claim_pipeline_job(
  p_worker text default null,
  p_stale_after_seconds integer default 1800
)
returns public.pipeline_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.pipeline_jobs;
  v_stale_seconds integer;
begin
  v_stale_seconds := greatest(60, coalesce(p_stale_after_seconds, 1800));

  update public.pipeline_jobs
  set
    status = 'RETRY',
    run_after = now(),
    locked_at = null,
    locked_by = null,
    finished_at = null,
    last_error = left(
      coalesce(last_error || E'\n', '')
      || '[auto-recovered] stale RUNNING job reclaimed by claim_pipeline_job',
      8000
    )
  where status = 'RUNNING'
    and coalesce(locked_at, started_at, updated_at, created_at)
      <= now() - make_interval(secs => v_stale_seconds);

  select *
  into v_job
  from public.pipeline_jobs
  where status in ('QUEUED', 'RETRY')
    and run_after <= now()
  order by priority asc, created_at asc
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.pipeline_jobs
  set
    status = 'RUNNING',
    attempts = attempts + 1,
    locked_at = now(),
    locked_by = coalesce(nullif(trim(p_worker), ''), 'worker'),
    started_at = coalesce(started_at, now()),
    finished_at = null
  where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;

grant execute on function public.claim_pipeline_job(text, integer) to authenticated, service_role;
