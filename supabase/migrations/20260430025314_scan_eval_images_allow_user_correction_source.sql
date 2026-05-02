-- The iOS app + the /api/admin/scan-eval/promote route both write
-- captured_source = 'user_correction' when a user taps "Not this card?"
-- in CardDetailView (or "None of these" in the medium picker, once the
-- correction-search UI ships). The original CHECK constraint omitted
-- 'user_correction', so every correction promote since the feature
-- shipped has 500'd silently — discovered 2026-04-29 during Day 3
-- real-device validation when 5 promotions all failed with
-- scan_eval_images_captured_source_check.
--
-- Fix: drop and re-add the constraint with the missing value.

ALTER TABLE public.scan_eval_images
  DROP CONSTRAINT IF EXISTS scan_eval_images_captured_source_check;

ALTER TABLE public.scan_eval_images
  ADD CONSTRAINT scan_eval_images_captured_source_check
  CHECK (captured_source IN (
    'user_photo',
    'user_correction',
    'telemetry',
    'synthetic',
    'roboflow'
  ));

COMMENT ON COLUMN public.scan_eval_images.captured_source IS
  'How this eval image entered the corpus: user_photo (manually labeled photo via EvalSeedingView), user_correction (user tapped "Not this card?" or picker-search after a misidentified scan), telemetry (auto-promoted from a scan_identify_events row), synthetic (generated/augmented), roboflow (imported from Roboflow project).';
