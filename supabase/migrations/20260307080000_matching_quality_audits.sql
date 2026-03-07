-- Daily matching-quality snapshots for provider_observation_matches.

create table if not exists public.matching_quality_audits (
  id bigserial primary key,
  captured_at timestamptz not null default now(),
  provider text not null,
  window_hours integer not null default 24,
  total_observations integer not null,
  matched_count integer not null,
  unmatched_count integer not null,
  matched_pct numeric not null,
  missing_provider_set_map_count integer not null,
  ambiguous_count integer not null,
  low_confidence_blocked_count integer not null,
  low_confidence_matched_count integer not null,
  avg_match_confidence numeric null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists matching_quality_audits_provider_captured_idx
  on public.matching_quality_audits (provider, captured_at desc);

