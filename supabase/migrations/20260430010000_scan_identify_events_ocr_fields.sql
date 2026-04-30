-- Adds the OCR fields iOS sends in the URL query string to
-- scan_identify_events so production telemetry shows what the
-- on-device OCR layer extracted on each scan. Critical for diagnosing
-- Path B / Path A activation failures (e.g., 2026-04-30 real-device
-- session showed iOS was sending garbage set_hint flavor text without
-- visibility, triggering one Path A false-positive).
--
-- Both nullable: Vision OCR is fail-graceful per-field — it routinely
-- returns one but not the other.

ALTER TABLE public.scan_identify_events
  ADD COLUMN IF NOT EXISTS ocr_card_number TEXT,
  ADD COLUMN IF NOT EXISTS ocr_set_hint TEXT;

COMMENT ON COLUMN public.scan_identify_events.ocr_card_number IS
  'On-device OCR collector number sent by the client (?card_number=). NULL when iOS Vision could not extract one. Used in Day 2 Path A/B retrieval — see scan_identify_events.winning_path.';
COMMENT ON COLUMN public.scan_identify_events.ocr_set_hint IS
  'On-device OCR set-name hint sent by the client (?set_hint=). NULL when iOS Vision returned no plausible set-name line. Used in Day 2 Path A retrieval.';
