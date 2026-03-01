create table if not exists public.tracked_refresh_diagnostics (
  id uuid primary key default gen_random_uuid(),
  run_id uuid null references public.ingest_runs(id) on delete set null,
  canonical_slug text not null references public.canonical_cards(slug) on delete cascade,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  reason text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tracked_refresh_diagnostics_created_at_idx
  on public.tracked_refresh_diagnostics (created_at desc);

create index if not exists tracked_refresh_diagnostics_run_id_idx
  on public.tracked_refresh_diagnostics (run_id);

create index if not exists tracked_refresh_diagnostics_printing_id_idx
  on public.tracked_refresh_diagnostics (printing_id);
