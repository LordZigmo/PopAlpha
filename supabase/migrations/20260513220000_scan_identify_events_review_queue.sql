-- 20260513220000_scan_identify_events_review_queue.sql
--
-- Adds `review_queued_at` to scan_identify_events. Set on the
-- "we don't know why this failed" subset of scans (currently
-- confidence='medium' AND ocr_card_number_extracted=false) — the
-- failure-case auto-capture path persists the cropped image into
-- scan-uploads/review-queue/<hash>.jpg in parallel and stamps this
-- column so operators can find them.
--
-- Tier 1.5 §6 item 2 of the scanner accuracy playbook. Without
-- this, production telemetry tells us the RATE of failures but
-- not what they LOOK LIKE.
--
-- Browsing query (operator-facing):
--   SELECT image_hash, top_match_slug, top_similarity, ocr_card_number,
--          ocr_pass2_fallback_fired, ocr_spatial_filter_rejected_count
--     FROM public.scan_identify_events
--    WHERE review_queued_at IS NOT NULL
--    ORDER BY created_at DESC
--    LIMIT 50;
-- Then view the image at:
--   card-images/scan-uploads/review-queue/<image_hash>.jpg

ALTER TABLE public.scan_identify_events
  ADD COLUMN IF NOT EXISTS review_queued_at timestamptz;

-- Partial index keeps the cost near-zero on the dominant non-queued
-- rows; only the failure-case subset participates in index scans.
CREATE INDEX IF NOT EXISTS scan_identify_events_review_queue_idx
  ON public.scan_identify_events (created_at DESC)
  WHERE review_queued_at IS NOT NULL;
