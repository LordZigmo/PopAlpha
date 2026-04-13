-- Add spread and sample-count columns to price_snapshots for graded
-- price fidelity. Graded markets are thin; a single market price
-- misrepresents certainty. low_value / high_value / sample_count
-- carry the spread from Scrydex so downstream UX can render
-- confidence bands ("PSA 10: $140–$175, 3 sales").
--
-- Raw write path leaves these null (backward-compatible).
-- Graded write path populates from Scrydex row.low / row.high.

alter table public.price_snapshots
  add column if not exists low_value    numeric null,
  add column if not exists high_value   numeric null,
  add column if not exists sample_count integer null;

-- No new indexes — spread columns are read alongside price_value
-- via the existing slug+grade+observed_at index.
