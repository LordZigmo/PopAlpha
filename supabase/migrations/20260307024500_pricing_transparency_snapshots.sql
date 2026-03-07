create table if not exists public.pricing_transparency_snapshots (
  id bigserial primary key,
  captured_at timestamptz not null default now(),
  freshness_pct double precision null,
  coverage_both_pct double precision null,
  p90_spread_pct double precision null,
  queue_depth integer null,
  retry_depth integer null,
  failed_depth integer null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_pricing_transparency_snapshots_captured_at
  on public.pricing_transparency_snapshots (captured_at desc);

alter table public.pricing_transparency_snapshots enable row level security;

drop policy if exists pricing_transparency_snapshots_read on public.pricing_transparency_snapshots;
create policy pricing_transparency_snapshots_read
on public.pricing_transparency_snapshots
for select
to anon, authenticated
using (true);

