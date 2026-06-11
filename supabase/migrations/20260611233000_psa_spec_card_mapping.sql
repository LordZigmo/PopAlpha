-- PSA SpecID → catalog mapping (Population Tables, Phase 2 —
-- docs/psa-specid-mapping-handoff.md).
--
-- Phase 1 (20260611213000_psa_spec_pop_snapshots.sql) accumulates
-- SpecID-keyed population snapshots; nothing ties a SpecID to a card the
-- app knows. This migration adds the mapping layer so
-- psa_spec_targets.canonical_slug can be filled accurately enough to bet
-- a user-facing POP surface on:
--
--   psa_set_map       — PSA Brand string → canonical set_code backbone
--                       (the analog of provider_set_map). Curated rows
--                       (MANUAL/SEED) always win; the matcher persists
--                       its deterministic derivations as source='DERIVED'
--                       so every brand→set assumption is visible and
--                       correctable in SQL, never buried in code.
--   psa_spec_card_map — per-spec match outcome (the analog of
--                       provider_card_map): canonical_slug + optional
--                       printing_id (a spec is finer than a card — e.g.
--                       1st Edition Holo vs Unlimited), mapping_status
--                       MATCHED/UNMATCHED, confidence, match_reason as
--                       the review-queue discriminator, verified flag for
--                       owner-confirmed ground truth the pipeline must
--                       never overwrite.
--
-- No seed rows here: with 4 specs harvested to date the backbone is
-- curated interactively (see the handoff doc); the DERIVED path covers
-- mechanically-derivable brands from day one.
--
-- Both new functions are NEW definers (no -- supersedes: required by
-- check:migrations:fnbody). SECURITY DEFINER + revoked from
-- public/anon/authenticated, mirroring the JP scan RPCs: only the
-- service-role pipeline may execute them.

create table if not exists public.psa_set_map (
  -- normalizePsaBrandKey(Brand): uppercase, ASCII quotes, single spaces.
  psa_brand_key       text        primary key,
  canonical_set_code  text        not null,  -- card_printings.set_code
  canonical_set_name  text        null,      -- human-readable reference
  language            text        not null default 'EN',
  confidence          numeric     not null default 1.0,
  source              text        not null default 'MANUAL'
                                  check (source in ('SEED', 'DERIVED', 'MANUAL')),
  notes               text        null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists psa_set_map_set_code_idx
  on public.psa_set_map (canonical_set_code);

create table if not exists public.psa_spec_card_map (
  spec_id           integer     primary key
                                references public.psa_spec_targets(spec_id) on delete cascade,
  canonical_slug    text        null
                                references public.canonical_cards(slug) on delete set null,
  printing_id       uuid        null
                                references public.card_printings(id) on delete set null,
  mapping_status    text        not null
                                check (mapping_status in ('MATCHED', 'UNMATCHED')),
  match_type        text        null,
  match_confidence  numeric     null,
  match_reason      text        null,
  mapping_source    text        not null default 'PIPELINE'
                                check (mapping_source in ('PIPELINE', 'MANUAL')),
  -- Owner-confirmed ground truth (spot-checked against psacard.com).
  -- The matcher skips verified rows unconditionally, force included.
  verified          boolean     not null default false,
  metadata          jsonb       not null default '{}'::jsonb,
  matched_at        timestamptz null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists psa_spec_card_map_status_idx
  on public.psa_spec_card_map (mapping_status, updated_at desc);

create index if not exists psa_spec_card_map_canonical_idx
  on public.psa_spec_card_map (canonical_slug)
  where canonical_slug is not null;

-- The review queue: unmatched specs grouped by why.
create index if not exists psa_spec_card_map_reason_idx
  on public.psa_spec_card_map (match_reason)
  where mapping_status = 'UNMATCHED';

-- Server-only tables: RLS on with no policies — anon/authed clients get
-- nothing, the service role bypasses (same posture as psa_spec_targets).
alter table public.psa_set_map enable row level security;
alter table public.psa_spec_card_map enable row level security;

create or replace function public.psa_set_map_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_psa_set_map_set_updated_at on public.psa_set_map;
create trigger trg_psa_set_map_set_updated_at
before update on public.psa_set_map
for each row execute function public.psa_set_map_set_updated_at();

create or replace function public.psa_spec_card_map_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_psa_spec_card_map_set_updated_at on public.psa_spec_card_map;
create trigger trg_psa_spec_card_map_set_updated_at
before update on public.psa_spec_card_map
for each row execute function public.psa_spec_card_map_set_updated_at();

revoke execute on function public.psa_set_map_set_updated_at() from public, anon, authenticated;
revoke execute on function public.psa_spec_card_map_set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- scan_canonical_set_index
--
-- One row per (set_code, language) in card_printings with name and year
-- bounds — the matcher's derivation target. PostgREST cannot express the
-- GROUP BY, hence the RPC. The sets table (20260509130000_sets_catalog)
-- is keyed by normalize_set_id(set_name), NOT set_code, so it cannot
-- serve this purpose.
-- ---------------------------------------------------------------------------
create or replace function public.scan_canonical_set_index()
returns table (
  set_code text,
  set_name text,
  language text,
  year_min int,
  year_max int,
  printings int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.set_code,
    max(p.set_name) as set_name,
    p.language,
    min(p.year) as year_min,
    max(p.year) as year_max,
    count(*)::int as printings
  from public.card_printings p
  where p.set_code is not null
  group by p.set_code, p.language
$$;

revoke execute on function public.scan_canonical_set_index()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- scan_psa_spec_cert_fields
--
-- Latest structured PSACert fields per spec, pulled from the cert lookup
-- stores. psa_spec_targets.description is a lossy space-joined concat of
-- these fields (set names and subjects both contain spaces — it cannot
-- be split back apart); the cert payloads carry them separated, so the
-- matcher always hydrates from here.
-- ---------------------------------------------------------------------------
create or replace function public.scan_psa_spec_cert_fields(p_spec_ids integer[])
returns table (
  spec_id integer,
  year text,
  brand text,
  category text,
  card_number text,
  subject text,
  variety text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (h.spec_id)
    h.spec_id, h.year, h.brand, h.category, h.card_number, h.subject, h.variety
  from (
    select
      (c.data->'raw'->'PSACert'->>'SpecID')::int as spec_id,
      c.data->'raw'->'PSACert'->>'Year'        as year,
      c.data->'raw'->'PSACert'->>'Brand'       as brand,
      c.data->'raw'->'PSACert'->>'Category'    as category,
      c.data->'raw'->'PSACert'->>'CardNumber'  as card_number,
      c.data->'raw'->'PSACert'->>'Subject'     as subject,
      c.data->'raw'->'PSACert'->>'Variety'     as variety,
      c.fetched_at
    from public.psa_cert_cache c
    where c.data->'raw'->'PSACert'->>'SpecID' ~ '^[0-9]+$'
      and (c.data->'raw'->'PSACert'->>'SpecID')::int = any(p_spec_ids)
    union all
    select
      (s.raw->'PSACert'->>'SpecID')::int,
      s.raw->'PSACert'->>'Year',
      s.raw->'PSACert'->>'Brand',
      s.raw->'PSACert'->>'Category',
      s.raw->'PSACert'->>'CardNumber',
      s.raw->'PSACert'->>'Subject',
      s.raw->'PSACert'->>'Variety',
      s.fetched_at
    from public.psa_cert_snapshots s
    where s.raw->'PSACert'->>'SpecID' ~ '^[0-9]+$'
      and (s.raw->'PSACert'->>'SpecID')::int = any(p_spec_ids)
  ) h
  order by h.spec_id, h.fetched_at desc nulls last
$$;

revoke execute on function public.scan_psa_spec_cert_fields(integer[])
  from public, anon, authenticated;

comment on table public.psa_set_map is
  'PSA Brand string -> canonical set_code backbone for SpecID matching. Curated rows (MANUAL/SEED) override; DERIVED rows are the matcher''s persisted deterministic resolutions, visible and correctable here.';
comment on table public.psa_spec_card_map is
  'PSA SpecID -> canonical card mapping (Population Tables Phase 2). UNMATCHED rows with match_reason form the review queue; verified=true rows are owner-confirmed and never overwritten by the pipeline.';
