create table if not exists public.outlier_excluded_points (
  id bigserial primary key,
  canonical_slug text not null,
  variant_ref text not null,
  provider text not null,
  observed_at timestamptz not null,
  observed_price numeric not null,
  reason text not null check (reason in ('MAD', 'IQR')),
  context jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists outlier_excluded_points_unique_idx
  on public.outlier_excluded_points (canonical_slug, variant_ref, provider, observed_at, reason);

create index if not exists outlier_excluded_points_captured_at_idx
  on public.outlier_excluded_points (captured_at desc);

create index if not exists outlier_excluded_points_slug_idx
  on public.outlier_excluded_points (canonical_slug);
