create table if not exists public.card_profiles (
  card_slug text primary key,
  summary_short text not null,
  summary_long text null,
  created_at timestamptz not null default now()
);
