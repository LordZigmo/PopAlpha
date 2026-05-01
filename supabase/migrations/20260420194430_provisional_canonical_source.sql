-- 20260420120000_provisional_canonical_source.sql
--
-- Supports auto-ingest of newly-released Pokemon sets (e.g. "Perfect Order",
-- Scrydex id `me3`) from the Scrydex API before pokemon-tcg-data has
-- published the set. New rows are tagged source='scrydex_provisional' and
-- are expected to be superseded when the next pokemon-tcg-data local
-- import lands.
--
-- Why: pokemon-tcg-data is the long-term canonical authority but is
-- community-maintained and typically lags new releases by weeks. The
-- discover-new-sets cron carves out a narrow provider→canonical import
-- path for set_ids that have never been seen before (never existing
-- canonical data).

alter table public.canonical_cards
  add column if not exists source text not null default 'pokemon-tcg-data';

comment on column public.canonical_cards.source is
  'Origin of the canonical identity: ''pokemon-tcg-data'' (default, long-term authority), ''scrydex_provisional'' (auto-ingested new-set rows awaiting pokemon-tcg-data), or ''scrydex''/''seed'' for legacy rows.';
