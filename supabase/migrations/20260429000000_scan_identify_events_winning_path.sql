-- Adds `winning_path` to scan_identify_events so production telemetry
-- shows which Day 2 retrieval path resolved each scan.
--
-- Possible values (free-text TEXT, not enum, so the route can iterate
-- without DDL):
--   'vision_only'           — current pipeline: kNN top-K, optional
--                              card_number / set_hint post-filters.
--                              Default for pre-Day-2 events.
--   'ocr_direct_unique'     — Path A unique: OCR card_number + set_hint
--                              both provided; SELECT canonical_cards
--                              with both filters returned exactly one
--                              row → returned as HIGH confidence
--                              regardless of CLIP signal.
--   'ocr_direct_narrow'     — Path A narrow: same direct query
--                              returned 2-3 rows; intersected with
--                              kNN ordering, returned as MEDIUM.
--   'ocr_intersect_unique'  — Path B unique: card_number-only direct
--                              query returned N rows; intersected
--                              with kNN top-K and exactly one slug
--                              survived → HIGH (dual-signal:
--                              OCR + CLIP agree).
--   'ocr_intersect_narrow'  — Path B narrow: 2-3 surviving slugs in
--                              the intersection → MEDIUM.
--
-- NULL is allowed because every existing row pre-dates Day 2 and we
-- don't want to backfill — they were all 'vision_only' implicitly.
-- The route SHOULD always set it for new events going forward.

ALTER TABLE public.scan_identify_events
  ADD COLUMN IF NOT EXISTS winning_path TEXT;

COMMENT ON COLUMN public.scan_identify_events.winning_path IS
  'Day 2 retrieval path that resolved the scan: vision_only | ocr_direct_unique | ocr_direct_narrow | ocr_intersect_unique | ocr_intersect_narrow. NULL on pre-Day-2 rows.';
