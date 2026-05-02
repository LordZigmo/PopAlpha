-- 20260423214617_scanner_eval_harness.sql
--
-- Stage A of the scanner-quality roadmap: a reproducible ground-truth
-- test set we can run `/api/scan/identify` against on demand. Before
-- this we had no way to measure whether any change (crop tweak,
-- threshold adjustment, detector swap, fine-tuned embedder) actually
-- moves accuracy — every decision was guesswork from a handful of
-- ad-hoc scans. The harness makes every change measurable.
--
-- Two tables:
--   scan_eval_images — the labeled corpus. One row per (image file,
--     known-correct canonical_slug) pair. Images themselves live in
--     the existing card-images bucket under scan-eval/<sha256>.jpg.
--   scan_eval_runs   — the score history. One row per invocation of
--     scripts/run-scanner-eval.mjs, carrying which model version /
--     crop params / thresholds were in effect plus per-image results
--     (jsonb) so we can diff runs.
--
-- Operator-only. RLS is enabled with no policies — service role
-- bypasses, anon/authenticated get nothing. No read path for end users.

create table if not exists public.scan_eval_images (
  id                      uuid primary key default gen_random_uuid(),
  canonical_slug          text not null references public.canonical_cards(slug) on delete restrict,
  image_storage_path      text not null unique,
  image_hash              text not null,
  image_bytes_size        integer not null,
  captured_source         text not null check (captured_source in (
    'user_photo', 'telemetry', 'synthetic', 'roboflow'
  )),
  captured_language       text not null default 'EN' check (captured_language in ('EN', 'JP')),
  notes                   text,
  created_at              timestamptz not null default now(),
  created_by              text
);

create index if not exists scan_eval_images_slug_idx
  on public.scan_eval_images (canonical_slug);

create index if not exists scan_eval_images_source_idx
  on public.scan_eval_images (captured_source);

create index if not exists scan_eval_images_language_idx
  on public.scan_eval_images (captured_language);

alter table public.scan_eval_images enable row level security;

-- ── Runs ──────────────────────────────────────────────────────────────

create table if not exists public.scan_eval_runs (
  id                      uuid primary key default gen_random_uuid(),
  ran_at                  timestamptz not null default now(),
  model_version           text not null,
  endpoint_url            text not null,

  -- Configuration snapshot: exactly what the pipeline was doing at the
  -- moment of the run so later comparisons are unambiguous.
  crop_params             jsonb not null default '{}'::jsonb,
  confidence_thresholds   jsonb not null default '{}'::jsonb,

  -- Aggregate metrics.
  n_total                 integer not null,
  n_top1_correct          integer not null default 0,
  n_top5_correct          integer not null default 0,
  n_confidence_high       integer not null default 0,
  n_confidence_medium     integer not null default 0,
  n_confidence_low        integer not null default 0,
  n_errors                integer not null default 0,

  -- Breakdowns for drill-down. Shape:
  --   per_set_accuracy:    { "151": {top1: 3, top5: 4, n: 4}, ... }
  --   per_source_accuracy: { "user_photo": {top1: 10, top5: 12, n: 12}, ... }
  per_set_accuracy        jsonb not null default '{}'::jsonb,
  per_source_accuracy     jsonb not null default '{}'::jsonb,

  -- Per-image outcomes for forensic diffing. Each entry:
  --   { image_id, expected_slug, actual_top1, actual_top5,
  --     similarity, gap_to_rank_2, confidence, duration_ms, error }
  detailed_results        jsonb not null default '[]'::jsonb,

  duration_ms             integer,
  notes                   text
);

create index if not exists scan_eval_runs_ran_at_idx
  on public.scan_eval_runs (ran_at desc);

create index if not exists scan_eval_runs_model_version_idx
  on public.scan_eval_runs (model_version);

alter table public.scan_eval_runs enable row level security;
