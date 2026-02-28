-- 20260301140000_variant_metrics.sql
--
-- variant_metrics: per-cohort signals keyed by (canonical_slug, variant_ref, provider, grade)
--
-- variant_ref is the full trading cohort identity (6 segments):
--   {finish}:{edition}:{stamp}:{condition}:{language}:{grade_level}
--
--   Examples:
--     "holofoil:unlimited:none:nm:en:raw"
--     "holofoil:1st-edition:none:nm:en:raw"
--     "reverse_holofoil:unlimited:none:nm:en:raw"
--     "sealed:unknown:none:sealed:en:raw"
--
-- Populated by sync-justtcg-prices after writing price_history_points.
-- Signals are only computed when history_points_30d >= 10.
--
-- Columns:
--   provider_* — raw values from the provider API (kept for signal recomputation)
--   signal_*   — squashed 0–100 scores (null when insufficient history)
--   history_points_30d — count of history points this run (sufficiency gate)

create table if not exists public.variant_metrics (
  id                                    uuid        primary key default gen_random_uuid(),
  canonical_slug                        text        not null references public.canonical_cards(slug) on delete cascade,
  variant_ref                           text        not null,
  provider                              text        not null,
  grade                                 text        not null default 'RAW',

  -- Provider-supplied raw analytics (kept for recomputation if formula changes)
  provider_trend_slope_7d               numeric     null,
  provider_cov_price_30d                numeric     null,
  provider_price_relative_to_30d_range  numeric     null,
  provider_price_changes_count_30d      integer     null,
  provider_as_of_ts                     timestamptz null,

  -- Sufficiency gate: number of 30d history points from provider this run
  history_points_30d                    integer     not null default 0,

  -- Derived signals: squashed 0–100 scores (null = insufficient data)
  signal_trend                          numeric     null,
  signal_breakout                       numeric     null,
  signal_value                          numeric     null,
  signals_as_of_ts                      timestamptz null,

  updated_at                            timestamptz not null default now()
);

-- One row per (canonical_slug, variant_ref, provider, grade) cohort.
create unique index if not exists variant_metrics_cohort_uidx
  on public.variant_metrics (canonical_slug, variant_ref, provider, grade);

create index if not exists variant_metrics_slug_idx
  on public.variant_metrics (canonical_slug);

create index if not exists variant_metrics_slug_ref_idx
  on public.variant_metrics (canonical_slug, variant_ref);
