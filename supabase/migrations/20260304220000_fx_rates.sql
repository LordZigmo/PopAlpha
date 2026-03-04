-- 20260304220000_fx_rates.sql
--
-- Daily FX storage for deterministic price conversions at observation time.

create table if not exists public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  pair text not null,
  base_currency text not null,
  quote_currency text not null,
  rate numeric not null,
  rate_date date not null,
  published_at timestamptz null,
  fetched_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fx_rates_pair_format check (pair ~ '^[A-Z]{6}$'),
  constraint fx_rates_positive_rate check (rate > 0)
);

create unique index if not exists fx_rates_source_pair_rate_date_uniq
  on public.fx_rates (source, pair, rate_date);

create index if not exists fx_rates_pair_rate_date_idx
  on public.fx_rates (pair, rate_date desc);

create index if not exists fx_rates_rate_date_idx
  on public.fx_rates (rate_date desc);

create or replace function public.fx_rates_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_fx_rates_set_updated_at on public.fx_rates;
create trigger trg_fx_rates_set_updated_at
before update on public.fx_rates
for each row execute function public.fx_rates_set_updated_at();
