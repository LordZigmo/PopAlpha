create table if not exists public.canonical_raw_provider_parity (
  canonical_slug text primary key,
  justtcg_finish text null,
  justtcg_edition text null,
  justtcg_stamp text null,
  justtcg_points_30d integer not null default 0,
  justtcg_as_of timestamptz null,
  scrydex_finish text null,
  scrydex_edition text null,
  scrydex_stamp text null,
  scrydex_points_30d integer not null default 0,
  scrydex_as_of timestamptz null,
  parity_status text not null default 'UNKNOWN' check (parity_status in ('MATCH', 'MISMATCH', 'MISSING_PROVIDER', 'UNKNOWN')),
  updated_at timestamptz not null default now()
);

create index if not exists idx_canonical_raw_provider_parity_status
  on public.canonical_raw_provider_parity (parity_status);

create or replace function public.refresh_canonical_raw_provider_parity(p_window_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  with matched as (
    select
      m.canonical_slug,
      m.provider,
      coalesce(o.normalized_finish, 'UNKNOWN') as normalized_finish,
      coalesce(o.normalized_edition, 'UNLIMITED') as normalized_edition,
      coalesce(o.normalized_stamp, 'NONE') as normalized_stamp,
      o.observed_at
    from public.provider_observation_matches m
    join public.provider_normalized_observations o
      on o.id = m.provider_normalized_observation_id
     and o.provider = m.provider
    where m.match_status = 'MATCHED'
      and m.canonical_slug is not null
      and m.provider in ('JUSTTCG', 'SCRYDEX')
      and o.observed_price is not null
      and o.observed_at >= now() - make_interval(days => greatest(1, coalesce(p_window_days, 30)))
  ),
  profile_counts as (
    select
      canonical_slug,
      provider,
      normalized_finish,
      normalized_edition,
      normalized_stamp,
      count(*)::integer as points_30d,
      max(observed_at) as latest_observed_at
    from matched
    group by canonical_slug, provider, normalized_finish, normalized_edition, normalized_stamp
  ),
  provider_top as (
    select *
    from (
      select
        pc.*,
        row_number() over (
          partition by pc.canonical_slug, pc.provider
          order by pc.points_30d desc, pc.latest_observed_at desc
        ) as rn
      from profile_counts pc
    ) ranked
    where rn = 1
  ),
  joined as (
    select
      c.slug as canonical_slug,
      j.normalized_finish as justtcg_finish,
      j.normalized_edition as justtcg_edition,
      j.normalized_stamp as justtcg_stamp,
      coalesce(j.points_30d, 0) as justtcg_points_30d,
      j.latest_observed_at as justtcg_as_of,
      s.normalized_finish as scrydex_finish,
      s.normalized_edition as scrydex_edition,
      s.normalized_stamp as scrydex_stamp,
      coalesce(s.points_30d, 0) as scrydex_points_30d,
      s.latest_observed_at as scrydex_as_of,
      case
        when j.canonical_slug is null and s.canonical_slug is null then 'UNKNOWN'
        when j.canonical_slug is null or s.canonical_slug is null then 'MISSING_PROVIDER'
        when j.normalized_finish = s.normalized_finish
          and j.normalized_edition = s.normalized_edition
          and coalesce(j.normalized_stamp, 'NONE') = coalesce(s.normalized_stamp, 'NONE')
          then 'MATCH'
        else 'MISMATCH'
      end as parity_status
    from public.canonical_cards c
    left join provider_top j
      on j.canonical_slug = c.slug and j.provider = 'JUSTTCG'
    left join provider_top s
      on s.canonical_slug = c.slug and s.provider = 'SCRYDEX'
  )
  insert into public.canonical_raw_provider_parity (
    canonical_slug,
    justtcg_finish,
    justtcg_edition,
    justtcg_stamp,
    justtcg_points_30d,
    justtcg_as_of,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    updated_at
  )
  select
    canonical_slug,
    justtcg_finish,
    justtcg_edition,
    justtcg_stamp,
    justtcg_points_30d,
    justtcg_as_of,
    scrydex_finish,
    scrydex_edition,
    scrydex_stamp,
    scrydex_points_30d,
    scrydex_as_of,
    parity_status,
    now()
  from joined
  on conflict (canonical_slug) do update
    set
      justtcg_finish = excluded.justtcg_finish,
      justtcg_edition = excluded.justtcg_edition,
      justtcg_stamp = excluded.justtcg_stamp,
      justtcg_points_30d = excluded.justtcg_points_30d,
      justtcg_as_of = excluded.justtcg_as_of,
      scrydex_finish = excluded.scrydex_finish,
      scrydex_edition = excluded.scrydex_edition,
      scrydex_stamp = excluded.scrydex_stamp,
      scrydex_points_30d = excluded.scrydex_points_30d,
      scrydex_as_of = excluded.scrydex_as_of,
      parity_status = excluded.parity_status,
      updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

alter table public.canonical_raw_provider_parity enable row level security;

drop policy if exists canonical_raw_provider_parity_read on public.canonical_raw_provider_parity;
create policy canonical_raw_provider_parity_read
on public.canonical_raw_provider_parity
for select
to anon, authenticated
using (true);

grant execute on function public.refresh_canonical_raw_provider_parity(integer) to authenticated, service_role;

