create table if not exists public.tracked_assets (
  canonical_slug text not null references public.canonical_cards(slug) on delete cascade,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  grade text not null default 'RAW',
  priority int not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (canonical_slug, printing_id, grade)
);

create index if not exists tracked_assets_enabled_priority_created_idx
  on public.tracked_assets (enabled, priority, created_at desc);

create index if not exists tracked_assets_canonical_slug_idx
  on public.tracked_assets (canonical_slug);

create index if not exists tracked_assets_printing_id_idx
  on public.tracked_assets (printing_id);

