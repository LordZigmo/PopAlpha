-- 20260301070000_provider_set_map.sql
--
-- provider_set_map: deterministic mapping from our canonical set_code to a
-- provider's internal set identifier (e.g. 'base-set-pokemon' for JustTCG).
--
-- Replaces fuzzy matching at ingest time. The sync job derives an initial
-- provider_set_id from the set_name slug, tries the fetch, then marks
-- confidence=1.0 if cards were returned or 0.0 if the set returned empty.
-- This makes mismatches visible and correctable without touching code.

create table if not exists public.provider_set_map (
  provider            text        not null,            -- 'JUSTTCG', 'TCGPLAYER', ...
  canonical_set_code  text        not null,            -- card_printings.set_code
  canonical_set_name  text        null,                -- human-readable reference
  provider_set_id     text        not null,            -- provider's own set identifier
  confidence          float       not null default 1.0, -- 1.0=verified, 0.0=no cards returned
  last_verified_at    timestamptz null,
  created_at          timestamptz not null default now(),
  primary key (provider, canonical_set_code)
);

-- Look up which canonical sets map to a given provider set ID.
create index if not exists provider_set_map_set_id_idx
  on public.provider_set_map (provider, provider_set_id);
