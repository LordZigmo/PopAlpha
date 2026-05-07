-- Phase 0 (Tier 1.5) telemetry: per-scan OCR diagnostic counters.
--
-- Why these three columns specifically:
--   ocr_card_number_extracted (bool) — Did OCR yield ANY card_number
--     candidate? Today we infer this from `ocr_card_number IS NOT
--     NULL`, but only when iOS bothered to send it. Explicit boolean
--     lets us distinguish "iOS sent nothing" from "iOS extracted
--     nothing" — different debugging targets.
--   ocr_pass2_fallback_fired (bool) — Did pass-1 (spatial-filter on)
--     return empty AND pass-2 (no spatial filter) recover anything?
--     Critical signal for Mode 8 — perspective-correction coord
--     quirk forces every scan onto pass-2 today, but we have no
--     aggregate count of how often that recovery actually saved a
--     scan vs left it empty.
--   ocr_spatial_filter_rejected_count (int) — Number of slash-bearing
--     observations Vision found OUTSIDE the bottom 35% region. High
--     counts indicate Mode 1 (loose hand grip) or Mode 2 (landscape
--     capture) — orientation/framing issues that the next round of
--     OCR work needs to target.
--
-- The fourth column the playbook contemplated
-- (ocr_perspective_corrected_extent jsonb, DEBUG-only) is deferred
-- until the saved-image inspection harness lands — without the
-- saved image to correlate, the extent values alone aren't
-- actionable.
--
-- All nullable: server-routed scans will populate them when iOS
-- sends the values as query params; offline scans (the dominant
-- path for premium users) won't write to scan_identify_events at
-- all in v1 — they'll emit PostHog events instead. Schema-side
-- nullability matches that reality.

ALTER TABLE public.scan_identify_events
  ADD COLUMN IF NOT EXISTS ocr_card_number_extracted BOOLEAN,
  ADD COLUMN IF NOT EXISTS ocr_pass2_fallback_fired BOOLEAN,
  ADD COLUMN IF NOT EXISTS ocr_spatial_filter_rejected_count INTEGER;

COMMENT ON COLUMN public.scan_identify_events.ocr_card_number_extracted IS
  'On-device OCR yielded ≥1 card_number candidate. NULL when client did not report. Distinct from ocr_card_number IS NOT NULL because the client may extract candidates and then choose not to send the first one (e.g., when none parse to a plausible value).';
COMMENT ON COLUMN public.scan_identify_events.ocr_pass2_fallback_fired IS
  'Pass-1 spatial-filter returned empty and pass-2 (no spatial filter) recovered ≥1 candidate. NULL when client did not report. Aggregate weekly to see Mode 8 / Mode 1 / Mode 2 prevalence.';
COMMENT ON COLUMN public.scan_identify_events.ocr_spatial_filter_rejected_count IS
  'Number of slash-bearing observations Vision found outside the bottom 35% region during pass-1. NULL when client did not report. High counts indicate orientation/framing failure modes (Mode 1 loose grip, Mode 2 landscape).';
