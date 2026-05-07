# Scanner accuracy playbook

> **The thesis, in one sentence:** at this point in the scanner's
> evolution, the dominant accuracy lever is OCR card_number
> robustness on real-device captures, NOT model improvements or
> ranking changes — and we have the eval data to prove it.

This is the master strategic document for ongoing scanner-accuracy
work. It supersedes `scanner-zero-tap-sprint.md` (which closed
2026-05-01) for the question "where do we invest next?". For
*operational* questions ("what does the scanner pipeline look
like?", "how do I debug a bad scan?", "how do I rollback a model
swap?") see `scanner-runbook.md`.

Companion to:
- `scanner-eval.md` — how the eval harness works
- `scanner-ocr-failure-modes.md` — running log of every observed
  real-device OCR failure, with diagnoses
- `scanner-runbook.md` — operational pipeline reference
- `scanner-finetune-runbook.md` — the SigLIP-2 fine-tune procedure
  (deferred Tier 2 work)

---

## 1. Where we are (post-Phase-2, 2026-05-07)

Three-mode eval against `https://popalpha.ai`, 323 labeled images:

| Mode | What it tests | Top-1 |
|---|---|---|
| **Default** (no OCR sent) | Pure pgvector kNN on SigLIP-2 + the orphan/digital-only filters | **72.1%** (233/323) |
| **Path B ceiling** (perfect OCR card_number, no set_hint) | kNN ∩ canonical_cards.card_number narrowing | **94.4%** (305/323) |
| **Path A ceiling** (perfect OCR card_number + set_hint) | Direct canonical_cards lookup with kNN tiebreak | **95.7%** (309/323) |

This shape — and *only* this shape — tells us where the gaps are:

| Gap | Size | What closes it |
|---|---|---|
| **Default → Path B** | **22.3pp** | Make iOS card_number OCR extract reliably on real-device captures |
| Path B → Path A | 1.3pp | Better set_hint extraction (mostly tapped out post-Phase-1) |
| Path A → 100% | 4.3pp | Better embedder (SigLIP-2 fine-tune or model swap) |

**The 22.3pp gap is the entire game right now.** When OCR
card_number fires correctly, we're at 94%+ regardless of
set_hint. When it doesn't, we're at 72%. Real-device evidence
2026-05-07 showed 2 of 5 hand-held scans had card_numbers Vision
*actually saw* but our spatial filter rejected — meaning the
ceiling we're hitting on real-device is the OCR-pipeline ceiling,
not the model ceiling.

## 2. The decision framework

Every proposed scanner-quality change must answer two questions
before we ship it:

### Q1. Which gap does it close?

| Lever | Gap targeted | Expected lift |
|---|---|---|
| OCR card_number robustness on real-device | Default → Path B | **5–20pp on real-device top-1** |
| Multi-frame consensus | Default mode (poor single-frame) | 3–8pp |
| set_hint refinement | Path B → Path A | <1.3pp (capped) |
| SigLIP-2 fine-tune | Path A → 100% | 2–4pp (raises the ceiling) |
| RFDETR supplemental classifier | Default mode (when OCR fails) | Unknown — depends on classifier coverage |
| Multi-card per-frame detection | Product feature, not accuracy | 0pp on single-card top-1 |

### Q2. What does the eval say after we ship?

No quality change is "done" until we re-run the three-mode eval
and see the delta in the right column. Re-baseline checkpoints are
the only signal we trust.

```bash
npm run eval:run -- --notes "after <change> — default OCR"
npm run eval:run -- --perfect-ocr --notes "after <change> — Path A ceiling"
npm run eval:run -- --perfect-ocr --no-set-hint --notes "after <change> — Path B ceiling"
```

The harness auto-compares each run against the previous run on
the same endpoint and writes a delta line. Diff lives in
`scan_eval_runs.detailed_results` so per-image regressions are
reviewable.

## 3. Current priority queue (post 2026-05-07)

### Tier 1 — High ROI, days

#### 1.1 Card_number OCR robustness on real-device (NEXT)

The headline work. Sub-levers, in order of expected impact:

**a. Orientation-aware spatial filter.** The current
`ios/PopAlphaApp/OCRService.swift:206-208` reject of `boundingBox.midY < 0.35`
assumes the card's bottom edge aligns with the image's bottom
edge. Real-device evidence shows two failure modes:

  - **Card photographed in landscape orientation** — frameSize
    858×600 etc. Card's "bottom" is on a side edge, not the bottom.
    The midY filter is meaningless.
  - **Card rotated ~180°** in the cropped image (perspective
    correction picked the long edge backwards). The copyright line
    "/ Nintendo / Creatures / GAME FREAK" lands at midY > 0.5 —
    the diagnostic confirms this directly.

  Fix shape: use the rectangle's detected angle from
  `PopAlphaVisionEngine` to rotate `imageForOCR` so card-bottom is
  always at image-bottom before OCR runs. Spatial filter then
  works as designed.

**b. Multi-pass with retries.** If pass 1 returns
`cardNumbers=[]` AND Vision saw slash-bearing text outside the
filter's accepted region, fall through to pass 2 with the spatial
filter disabled. Plausibility filter (`yInt ∈ [5, 600]`,
`xInt ∈ [1, 999]`) defends against the original Chansey
false-positive case. Asymmetric risk: false negative (rejected
real card_number) costs HIGH→medium confidence; false positive
(admitted non-card_number) costs a Path B no-match that falls
through harmlessly to Path C. FN much worse, so we lean toward
admission.

**c. Strip-pass tuning.** Today's strip is bottom 18% upscaled 3×.
Real-device evidence supports growing to 22-25%. Diminishing returns
above 25% (admits attack/rules text band).

**d. Image quality gates.** When a frame's mean luminance is too
low (dark) or per-channel variance is too high (blur), bump the
user with a "hold steadier" hint instead of running OCR on garbage.
Reduces "garbage in, confused output" without false confidence.
Implementation: lightweight metric on `imageForOCR` before OCR
runs; show a status toast if outside [bright, sharp] thresholds.

**Estimated effort:** 1–2 days for (a)–(c). Image quality gates
are a polish add-on.

#### 1.6 HIGH-confidence threshold review on `ocr_intersect_unique`

Real-device 2026-05-07 evidence (28-scan baseline) showed 5
scans hit `ocr_intersect_unique` with the right answer but
stayed at `confidence=medium` because the kNN top-1 sim was
below ~0.85. Examples:

```
Naclstack #83  ocr_intersect_unique sim=0.842 → medium
Hippowdon #53  ocr_intersect_unique sim=0.834 → medium
Kleavor #85    ocr_intersect_unique sim=0.764 → medium
```

When OCR card_number AND kNN top-1 AGREE on a unique slug,
that's two independent signals confirming the same answer —
should be HIGH regardless of the kNN's absolute sim. The
current threshold appears to gate HIGH on sim alone, ignoring
the OCR-confirmation signal.

Investigation: read the offline orchestrator's
`OfflineIdentifier.identifyWithCandidates` confidence-tier
logic. Adjust the threshold so `ocr_intersect_unique` returns
HIGH when:
- kNN top-1 slug matches the OCR card_number search result, AND
- The match is unique (only one slug in canonical_cards has
  that card_number), AND
- kNN top-1 sim > some lower bar like 0.75 (filtering out
  pure noise)

Estimated effort: ~half day (logic + threshold tuning + eval
re-run to confirm no false-HIGH regressions).

**Expected eval impact:** Default mode +5–10pp; Path B ceiling
unchanged (eval uses perfect OCR). Real-device top-1 should jump
10–20pp because most current real-device failures are
OCR-pipeline failures, not model failures.

#### 1.2 Multi-frame consensus on tap

On a tap-to-scan, capture 3–5 frames over ~600ms instead of 1.
Average embeddings, vote on OCR card_number candidates across
frames, return when 2+ frames agree at HIGH confidence. Best for
cards with single-frame issues (glare, motion blur, partial
occlusion).

Implement only on the tap path, not on auto-detect. Auto-detect is
already async + low-friction; multi-frame would slow it to
noticeable.

**Estimated effort:** 2–3 days.

**Expected real-device impact:** 3–8pp on tap scans; 0 on
auto-detect (which doesn't change).

### Tier 2 — Medium ROI, weeks

#### 2.1 SigLIP-2 fine-tune on user-correction corpus

The 4.3pp Path A → 100% gap is genuinely "the embedder confuses
these cards." We collect ground-truth corrections via
`source='user_correction'` rows in `card_image_embeddings`.
Fine-tune SigLIP-2 on those + the eval corpus.

Cost: $50–200 compute, 1–2 weeks of work, plus deployment plumbing
for the new model_version. See `scanner-finetune-runbook.md` for
the procedure.

**Only fire this once Tier 1 lands and real-device top-1 is at
~88-90%.** Fine-tune lifts 2–4pp, which is meaningful at 90% but
a rounding error at 75%.

#### 2.2 Real-device eval harness (process improvement)

Today's 323-image eval is server-side controlled images — does
not measure iOS OCR. Add a fixture-image suite that runs through
the bundled `.papb` on simulator with synthetic camera frames.
Gate releases on iOS-side top-1 not regressing.

Closes the gap between "eval looks great" and "user complains
scanner regressed". Today's smoke test was manual; this would
make it CI-runnable.

**Estimated effort:** 2–3 days, mostly fixture curation.

### Tier 3 — Speculative or domain-specific

#### 3.1 RFDETR as supplemental classifier

Phase 4 from the original sprint plan. Was contingent on Phase
1+2 leaving us under 88%. We're at 72.1% Default but 94.4% Path
B, so for users where OCR works we don't need RFDETR; for users
where OCR fails RFDETR could be a third independent signal.

Re-evaluate *after* Tier 1 lands. Tier 1 might lift Default high
enough that RFDETR's class-coverage limitations (closed-set
classifier, not all 26k slugs) become acceptable.

#### 3.2 JP scoreboard once catalog populates

Eval has 0 JP images today. Once the Scrydex `/ja/` import lands
~few hundred JP slugs (in progress 2026-05-07), add 50–100 JP
images and run the same 3-mode eval. Tells us whether SigLIP-2's
multilingual training generalizes to JP TCG cards or whether we
need a JP-specific fine-tune.

**Estimated effort:** 1 day to extend the harness for language
filtering + however long it takes to capture/upload JP images.

#### 3.3 Multi-card per-frame detection

Real users sometimes photograph binder pages or stacks. Currently
we crop the highest-confidence rectangle. Multi-card detection
means: detect all rectangles, run kNN per crop, return a list.
Useful product feature but doesn't move single-card accuracy.

Distinct from the **multi-scan mode** described in
`scanner-multi-scan-mode.md` — that's "scan many cards
sequentially into a batch", which is a UX feature that doesn't
require multi-card-per-frame detection. Multi-scan mode is
recommended to ship after Tier 1 lands; per-frame multi-card
detection stays Tier 3 speculative.

## 4. Things to skip (and why)

These get suggested periodically. They're not worth our time
right now:

- **More set_hint heuristic tuning.** The 1.3pp Path B → Path A
  gap caps the entire upside even with perfect set_hint
  extraction. Phase 1 set_hint v3 is at point of diminishing
  returns.
- **Bundling JP rows in `siglip2_catalog_v1.papb`.** Until JP
  catalog has ~5k+ slugs, the offline performance gain is small
  and the bundle size cost (current 37 MB → 50 MB+) is real.
  Server-route routing for JP is the right call until coverage
  justifies the bundle.
- **More complex orchestrator paths.** The two-tier offline-first
  / server-fallback structure in
  `ios/PopAlphaApp/ScannerTabView.swift:runIdentify` is correct.
  Don't add a third tier.
- **Augmentation-only embedder improvements.** Stage C
  augmentations capped at ~80% top-1 even at the perfect
  embedder ceiling per the sprint's eval data. They don't beat
  the OCR lever.
- **Replacing VNDetectRectanglesRequest with
  VNDetectDocumentSegmentationRequest.** Real-device data
  already shows handheld auto-detect fires ~67% of the time and
  produces correct top-1 ~83% when it does. The remaining gap is
  OCR-fixable per the eval. Defer detector swap until eval shows
  it's the next-biggest lever.

## 5. The data flywheel — how the scanner keeps improving

The scanner is a system that gets better over time IF (and only
if) we:

1. **Log every real-device OCR failure** with enough detail to
   diagnose it later. Done — `Logger.scan` emits OCR results,
   spatial-filter rejections, scan_e2e timing per scan.
2. **Capture failed scans into the eval corpus** so the next eval
   re-baseline measures the fix's effect on those exact cases.
   Mostly done — the user-correction → eval-promote pipeline
   already exists. Could be expanded with an "auto-promote on
   medium-confidence-with-no-card-number" heuristic.
3. **Catalog observed failure modes** so we don't whack the same
   mole twice. → `scanner-ocr-failure-modes.md` (running log).
4. **Re-baseline after every accuracy-touching change.** Diff
   `scan_eval_runs` rows. The harness auto-computes the delta —
   we just have to read it.

The current TestFlight build emits structured logs that
distinguish OCR pipeline failure modes:

  - `cardNumbers=[]` — Vision saw nothing slash-shaped, OR Vision
    saw it but the spatial filter rejected it
  - `ocr spatial filter rejected N slash-line(s)…` — diagnostic for
    the second case
  - `scan_e2e: confidence=medium ocr_ms=X total_ms=Y` —
    aggregate per-scan tracking

When scan_identify_events captures these, we can query "what
fraction of medium-confidence scans had card_numbers=[]?" and
prioritize accordingly.

## 6. Feedback loops we should add (Tier 1.5)

While shipping Tier 1, add the data we need to validate the
improvement:

- **Per-scan card_number-extraction telemetry.** Augment
  `scan_identify_events` with `ocr_card_numbers_extracted` (bool)
  and `ocr_spatial_filter_rejected_count` (int). Aggregate
  weekly: "are we extracting card_number on more scans than last
  week?"
- **Failure-case auto-capture.** When a scan returns
  confidence=medium AND `cardNumbers=[]`, automatically capture
  the cropped image into a "review queue" Storage path. Periodic
  human review categorizes the failure mode (orientation, blur,
  card-edge-cropped, etc.) and informs the next round of OCR
  work.
- **Running scoreboard per failure mode.** Keep a count in
  `scanner-ocr-failure-modes.md` of how many real-device
  examples we have of each mode. Not all modes deserve fixing —
  some are <1% of scans and don't move the needle.

## 7. Roll-up — the one-paragraph version

We just finished Phase 1+2 of the post-zero-tap-sprint scanner
work. Phase 2 was the big systemic win (model-version-aware
embed cron + SigLIP cutover backfill, +4.9pp Path B). Phase 1's
set_hint changes were the right call ex-ante but shipped a
diminishing-returns lever (the eval baseline before Phase 2
overstated set_hint's importance). The next move is OCR
card_number robustness on real-device — the entire 22.3pp
Default → Path B gap collapses if iOS OCR successfully extracts
the card_number on a higher percentage of frames. We have
real-device evidence of two specific failure modes (orientation
fragility, loose-frame card_number above the spatial threshold),
both fixable in 1–2 days. After that lands and we re-baseline,
re-evaluate whether RFDETR or SigLIP fine-tune is the next
biggest lever based on the new eval shape.
