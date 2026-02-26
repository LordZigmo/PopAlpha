alter table if exists public.private_sales
  add column if not exists payment_method text;
