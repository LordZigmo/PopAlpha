-- Multi-crop telemetry on scan_identify_events.
--
-- Added when /api/scan/identify started running two parallel kNN
-- queries per scan (one per crop_type) and merging max-by-slug. We
-- need to know:
--   * Which kNN found the eventual winner — full-card or art-only
--     crop — so we can validate that the art-crop path is pulling
--     its weight on real-world (occluded-corner) scans.
--   * The top similarity from each branch independently, even when
--     one branch lost the merge, so we can spot cases where they
--     agree closely vs. cases where one branch is far ahead.
--
-- All three columns are nullable: rows written by the single-crop
-- code path before this column existed are valid; new rows written
-- by the multi-crop path populate them.

alter table public.scan_identify_events
  add column if not exists full_top_similarity double precision,
  add column if not exists art_top_similarity  double precision,
  add column if not exists winning_crop        text
    check (winning_crop is null or winning_crop in ('full', 'art', 'tie'));

comment on column public.scan_identify_events.full_top_similarity is
  'Best similarity (1 - cos_dist) from the full-card kNN, before merge.';
comment on column public.scan_identify_events.art_top_similarity is
  'Best similarity (1 - cos_dist) from the art-crop kNN, before merge.';
comment on column public.scan_identify_events.winning_crop is
  'Which crop produced the merged top-1. "tie" when both branches returned the same top slug.';
