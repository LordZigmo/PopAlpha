-- Homepage precompute cache.
--
-- /api/homepage runs getHomepageData() — a heavy GLOBAL aggregation (~8s cold,
-- ~211KB) — on every edge-cache miss. The underlying data only changes daily
-- (signal board) / hourly (JP rails), so we precompute the payload off the hot
-- path (cron: refresh-homepage-cache) and store it here; the public route reads
-- the newest blob via public_homepage_latest (a cheap LIMIT 1), falling back to
-- a live getHomepageData() only if the blob is missing/stale. Mirrors the
-- ai_brief_cache + public_ai_brief_latest pattern (RLS-on table, public view).

create table if not exists public.homepage_cache (
  id          bigserial   primary key,
  payload     jsonb       not null check (jsonb_typeof(payload) = 'object'),
  data_as_of  timestamptz,
  computed_at timestamptz not null default now()
);

create index if not exists homepage_cache_computed_at_desc_idx
  on public.homepage_cache (computed_at desc);

-- Service-role writes only; no public table grants. Public reads go through the
-- view below, which runs as owner and bypasses RLS (same model as ai_brief_cache).
alter table public.homepage_cache enable row level security;

drop view if exists public.public_homepage_latest;
create view public.public_homepage_latest as
  select payload, data_as_of, computed_at
  from public.homepage_cache
  order by computed_at desc
  limit 1;

grant select on public.public_homepage_latest to anon, authenticated;
