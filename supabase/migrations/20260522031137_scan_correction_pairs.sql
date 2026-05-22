-- Durable hard-negative/correction-pair telemetry for scanner accuracy work.
--
-- One row per user correction submitted to /api/scan/correction. The image
-- itself remains in the existing scan-eval / user-correction storage flows;
-- this table stores the model's predicted top-1 (`from_slug`) and the user's
-- corrected slug (`to_slug`) plus the routing/similarity/OCR metadata needed
-- to diagnose whether misses are low-gap vision_only, repeat false attractors,
-- OCR-missing, or trigger-source-specific.
--
-- Operator-only. RLS is enabled with no policies; service role writes from the
-- server route, and analysts join by image_hash / eval_image_id.

create table if not exists public.scan_correction_pairs (
  id                              uuid primary key default gen_random_uuid(),
  created_at                      timestamptz not null default now(),

  image_hash                      text not null,
  eval_image_id                   uuid null references public.scan_eval_images(id) on delete set null,
  created_by                      text null,

  from_slug                       text null,
  to_slug                         text not null references public.canonical_cards(slug) on delete restrict,
  confidence                      text null check (confidence in ('high', 'medium', 'low', 'error')),
  winning_path                    text null,
  trigger_source                  text null,
  source                          text null,
  model_version                   text null,

  top_similarity                  double precision null,
  top_gap                         double precision null,
  rank2_slug                      text null,
  rank2_similarity                double precision null,

  ocr_card_number                 text null,
  ocr_set_hint                    text null,
  ocr_card_number_extracted       boolean null,
  ocr_card_numbers_count          integer null check (ocr_card_numbers_count is null or ocr_card_numbers_count >= 0),

  notes                           text null
);

create index if not exists scan_correction_pairs_created_at_idx
  on public.scan_correction_pairs (created_at desc);

create index if not exists scan_correction_pairs_image_hash_idx
  on public.scan_correction_pairs (image_hash);

create index if not exists scan_correction_pairs_eval_image_id_idx
  on public.scan_correction_pairs (eval_image_id)
  where eval_image_id is not null;

create index if not exists scan_correction_pairs_from_to_idx
  on public.scan_correction_pairs (from_slug, to_slug);

create index if not exists scan_correction_pairs_winning_path_idx
  on public.scan_correction_pairs (winning_path)
  where winning_path is not null;

create index if not exists scan_correction_pairs_confidence_idx
  on public.scan_correction_pairs (confidence)
  where confidence is not null;

alter table public.scan_correction_pairs enable row level security;

comment on table public.scan_correction_pairs is
  'User-submitted scanner correction pairs: model top-1/from_slug -> corrected to_slug plus confidence, path, similarity gap, rank-2, OCR, and trigger metadata.';
comment on column public.scan_correction_pairs.from_slug is
  'Model/display top-1 slug at the time the user corrected the scan. Nullable for older clients or manual flows.';
comment on column public.scan_correction_pairs.to_slug is
  'User-confirmed correct canonical_cards.slug.';
comment on column public.scan_correction_pairs.top_gap is
  'top_similarity - rank2_similarity from the client-visible candidate list.';
comment on column public.scan_correction_pairs.trigger_source is
  'Scanner entry path such as auto, tap, tap_multiframe, or library.';
comment on column public.scan_correction_pairs.ocr_card_numbers_count is
  'Number of OCR collector-number candidates extracted on-device.';
