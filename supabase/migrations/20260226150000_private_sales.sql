create table if not exists public.private_sales (
  id uuid primary key default gen_random_uuid(),
  cert text not null,
  price numeric not null,
  currency text not null default 'USD',
  sold_at timestamptz not null,
  fees numeric,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists private_sales_cert_sold_at_idx
  on public.private_sales (cert, sold_at desc);
