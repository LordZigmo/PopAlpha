-- PSA SpecID inventory expansion (Population Tables Phase 2b —
-- docs/psa-specid-mapping-handoff.md, "Decisions" addendum).
--
-- Phase 1 harvests SpecIDs organically from slab scans — 4 specs to
-- date. Whole-catalog population coverage needs proactive discovery:
-- PSA's pop-report set pages (POST www.psacard.com/Pop/GetSetItems,
-- keyed by a numeric heading id) enumerate EVERY spec in a set — and
-- each row carries the current grade distribution, so one page fetch
-- yields both the spec inventory and a same-day pop snapshot without
-- spending the official API's ~100/day quota. The official API cron
-- (snapshot-psa-pop) remains the verification / priority lane.
--
--   psa_pop_set_pages — scrape rotation registry, one row per PSA pop
--     set page (heading_id). canonical_set_code links the page into our
--     catalog so specs discovered from it match with set identity KNOWN
--     (stronger than parsing PSA Brand strings). Owner-seeded for now;
--     automated crawl of the category browse pages is a follow-up.
--   psa_spec_targets.fields — structured spec fields (year/brand/
--     category/cardNumber/subject/variety) captured AT DISCOVERY time.
--     Cert-scanned specs hydrate from cert payloads
--     (scan_psa_spec_cert_fields); scraped specs have no cert payload,
--     so discovery must store what the page gave it.
--   psa_spec_targets.pop_heading_id — which pop page surfaced the spec.
--   psa_spec_pop_snapshots.source — provenance: 'api' (official
--     GetPSASpecPopulation) vs 'pop_scrape' (set-page rows).

create table if not exists public.psa_pop_set_pages (
  heading_id          integer     primary key,
  category_id         integer     not null,
  -- Page title as shown on psacard.com ("2023 Pokemon Japanese SV4a
  -- Shiny Treasure ex") — doubles as the Brand context for specs
  -- discovered here.
  title               text        not null,
  year                text        null,
  language            text        not null default 'EN',
  -- Curated/derived link into card_printings.set_code. When set, specs
  -- from this page skip brand parsing entirely.
  canonical_set_code  text        null,
  set_confidence      numeric     not null default 1.0,
  source              text        not null default 'MANUAL'
                                  check (source in ('MANUAL', 'DERIVED', 'CRAWL')),
  active              boolean     not null default true,
  last_scraped_on     date        null,
  last_spec_count     integer     null,
  notes               text        null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists psa_pop_set_pages_rotation_idx
  on public.psa_pop_set_pages (active, last_scraped_on asc nulls first);

alter table public.psa_pop_set_pages enable row level security;

create or replace function public.psa_pop_set_pages_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_psa_pop_set_pages_set_updated_at on public.psa_pop_set_pages;
create trigger trg_psa_pop_set_pages_set_updated_at
before update on public.psa_pop_set_pages
for each row execute function public.psa_pop_set_pages_set_updated_at();

revoke execute on function public.psa_pop_set_pages_set_updated_at()
  from public, anon, authenticated;

alter table public.psa_spec_targets
  add column if not exists fields jsonb null;

alter table public.psa_spec_targets
  add column if not exists pop_heading_id integer null
    references public.psa_pop_set_pages(heading_id) on delete set null;

create index if not exists psa_spec_targets_pop_heading_idx
  on public.psa_spec_targets (pop_heading_id)
  where pop_heading_id is not null;

alter table public.psa_spec_pop_snapshots
  add column if not exists source text not null default 'api';

comment on table public.psa_pop_set_pages is
  'Rotation registry for PSA pop-report set pages (Pop/GetSetItems). One page fetch enumerates every spec in the set AND its current grade distribution — the whole-catalog discovery channel; the official API stays the verification lane.';
comment on column public.psa_spec_targets.fields is
  'Structured spec fields {year,brand,category,cardNumber,subject,variety} captured at harvest/discovery time. Preferred over scan_psa_spec_cert_fields when present; scraped specs have no cert payload to hydrate from.';
comment on column public.psa_spec_pop_snapshots.source is
  'Snapshot provenance: api = official GetPSASpecPopulation, pop_scrape = pop-report set-page rows.';
