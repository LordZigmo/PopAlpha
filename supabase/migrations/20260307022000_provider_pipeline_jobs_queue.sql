-- Queue-backed provider pipeline orchestration.
-- Moves long-running provider jobs out of single cron invocations.

create table if not exists public.pipeline_jobs (
  id bigserial primary key,
  provider text not null check (provider in ('JUSTTCG', 'SCRYDEX')),
  job_kind text not null check (job_kind in ('PIPELINE', 'RETRY')),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED')),
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 6 check (max_attempts >= 1),
  run_after timestamptz not null default now(),
  params_json jsonb not null default '{}'::jsonb,
  locked_at timestamptz null,
  locked_by text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null,
  last_result jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pipeline_jobs_claim
  on public.pipeline_jobs (status, run_after, priority, created_at);

create index if not exists idx_pipeline_jobs_provider_kind_status
  on public.pipeline_jobs (provider, job_kind, status, created_at desc);

create or replace function public.pipeline_jobs_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pipeline_jobs_set_updated_at on public.pipeline_jobs;
create trigger trg_pipeline_jobs_set_updated_at
before update on public.pipeline_jobs
for each row execute function public.pipeline_jobs_set_updated_at();

create or replace function public.claim_pipeline_job(p_worker text default null)
returns public.pipeline_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.pipeline_jobs;
begin
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

create or replace function public.complete_pipeline_job(
  p_job_id bigint,
  p_ok boolean,
  p_result jsonb default null,
  p_error text default null,
  p_retry_delay_seconds integer default 300
)
returns public.pipeline_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.pipeline_jobs;
  v_status text;
begin
  select *
  into v_job
  from public.pipeline_jobs
  where id = p_job_id
  for update;

  if not found then
    return null;
  end if;

  if p_ok then
    v_status := 'SUCCEEDED';
  elsif v_job.attempts >= v_job.max_attempts then
    v_status := 'FAILED';
  else
    v_status := 'RETRY';
  end if;

  update public.pipeline_jobs
  set
    status = v_status,
    run_after = case when v_status = 'RETRY'
      then now() + make_interval(secs => greatest(30, coalesce(p_retry_delay_seconds, 300)))
      else run_after
    end,
    finished_at = case when v_status in ('SUCCEEDED', 'FAILED') then now() else null end,
    locked_at = null,
    locked_by = null,
    last_error = case when p_ok then null else left(coalesce(p_error, 'pipeline job failed'), 8000) end,
    last_result = p_result
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

grant execute on function public.claim_pipeline_job(text) to authenticated, service_role;
grant execute on function public.complete_pipeline_job(bigint, boolean, jsonb, text, integer) to authenticated, service_role;

