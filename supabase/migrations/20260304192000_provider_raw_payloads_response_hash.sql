-- Make raw provider payload storage idempotent for identical request+response pairs
-- without blocking future snapshots when the upstream payload changes.

alter table public.provider_raw_payloads
  add column if not exists response_hash text null;

update public.provider_raw_payloads
set response_hash = md5(response::text)
where response_hash is null;

with ranked as (
  select
    id,
    row_number() over (
      partition by request_hash, response_hash
      order by fetched_at asc, id asc
    ) as row_num
  from public.provider_raw_payloads
  where request_hash is not null
    and response_hash is not null
)
delete from public.provider_raw_payloads p
using ranked r
where p.id = r.id
  and r.row_num > 1;

create unique index if not exists provider_raw_payloads_request_response_uidx
  on public.provider_raw_payloads (request_hash, response_hash)
  where request_hash is not null
    and response_hash is not null;
