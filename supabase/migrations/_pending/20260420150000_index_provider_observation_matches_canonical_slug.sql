-- 20260420150000_index_provider_observation_matches_canonical_slug.sql
--
-- Add missing FK index on provider_observation_matches(canonical_slug).
-- Continues the cleanup from 20260414233000_index_unindexed_foreign_keys.sql,
-- which missed this column.
--
-- The FK has ON DELETE SET NULL on canonical_cards(slug); without an index
-- on the referencing column, every canonical_cards delete triggers a full
-- scan of provider_observation_matches (1.6M+ rows) and times out. This
-- blocked the cleanup of the first provisional Scrydex seeding attempt.
--
-- Using CONCURRENTLY to avoid blocking pipeline writes. Safe to re-run via
-- IF NOT EXISTS.

create index concurrently if not exists
  idx_provider_observation_matches_canonical_slug
  on public.provider_observation_matches (canonical_slug);
