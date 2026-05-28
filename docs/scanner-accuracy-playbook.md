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

## 0. First real-device verified-correctness baseline (2026-05-21)

First session where the multi-scan correction loop ran end-to-end
with deliberate per-row review by a single user. Methodology lets
us treat uncorrected-tray rows as user-accepted = ground truth
(solo-user-deliberate-review only; unsafe to extrapolate to
production — see `scanner-ocr-failure-modes.md` Caveats).

| Metric | Value |
|---|---|
| Top-1 correctness | **40/53 = 75.5%** |
| HIGH precision | 21/24 = 87.5% |
| MEDIUM precision | 19/29 = 65.5% |
| HIGH-wrong rate | 3/53 = 5.7% |
| OCR extraction rate | 35/53 = 66.0% |

Session was 100% Journey Together — modern, well-printed, fully
SigLIP-embedded, fully priced. The 75.5% number is **set-specific
and probably optimistic vs. a heterogeneous real-world mix** (older
cards, holos, JP cards, finger-occluded captures). First priority
is to repeat on 1–2 different sets to triangulate.

**Dominant remaining error mode: cross-set confusion (11/13 errors,
85%).** The system's top-1 picked a card from a *different* set
than the scanned card in 11 of 13 wrongs. Two specific slugs act
as repeated false-attractors across unrelated Journey Together
scans:

- `perfect-order-84-rosa's-encouragement` (false-attractor on 2 scans)
- `prismatic-evolutions-53-hippowdon` (false-attractor on 2 scans)

This is exactly the lever Tier 2 SigLIP-2 fine-tune addresses
(see §2.1). The 13 corrections from this session are the seed
labeled-negative pairs.

**HIGH-wrong cases (most user-facing-dangerous, all 3 are
`vision_only` winning_path):**
- destined-rivals-166-granite-cave → jt-152-n's-castle
- silver-tempest-139-lugia-vstar → jt-24-blaziken-ex
- mega-evolution-19-vulpix → jt-119-furret

All three share layout/style with the user-correct slug (stadium
cards, full-art ex/VSTAR, small mammals on similar background).
Trust-killer demote only fires when Path-B's promoted slug ≠ kNN
top-1, but `vision_only` means no Path-B narrowing → demote
doesn't engage. **Open question for Tier 1.7: should `vision_only`
HIGH require a wider sim-gap-to-rank-2 than the current Phase 1.5
floor?**

**Saliency-in-multi-scan fix (PR #114) verified working in
practice.** 1/53 = 1.9% `auto_saliency` events; zero non-card
pollution. Mode 10 closed.

**Phase 0d perspective-extent sample gate met.** 51 corrected
samples this session (vs. 27 cumulative prior). Mode 8 coord-system
fix is unblocked from the data side — diagnostic-then-fix rule
still binds.

**Pre-session thesis update.** The dominant accuracy lever has
shifted. Cross-set confusion now drives ≥85% of measured errors;
OCR card_number robustness (the old §1 thesis) is necessary but no
longer sufficient. The next phase is embedder-side: either a
SigLIP-2 fine-tune (Tier 2) or a sim-gap-aware HIGH gate for
`vision_only` (Tier 1.7).

---

## 1. Where we are (post-Phase-1, 2026-05-08)

Three-mode eval against `https://popalpha.ai`, 323 labeled images:

| Mode | What it tests | Top-1 |
|---|---|---|
| **Default** (no OCR sent) | Pure pgvector kNN on SigLIP-2 + the orphan/digital-only filters | **79.3%** (256/323) |
| **Path B ceiling** (perfect OCR card_number, no set_hint) | kNN ∩ canonical_cards.card_number narrowing | **94.7%** (306/323) |
| **Path A ceiling** (perfect OCR card_number + set_hint) | Direct canonical_cards lookup with kNN tiebreak | **96.0%** (310/323) |

The Default-mode lift from the previous baseline (72.1% → 79.3%) is
NOT from Phase 1 — it's from the SigLIP embedding backfill that
landed after the model-version-aware cron filter shipped (commit
`23bb75d`, 2026-05-07: ~1,486 rows backfilled). Phase 1 itself moved
the confidence-tier distribution within Path B (more HIGH, fewer
MEDIUM-but-correct) without changing top-1 ranking — see §3 Tier 1.6
for the mechanism.

This shape — and *only* this shape — tells us where the gaps are:

| Gap | Size | What closes it |
|---|---|---|
| **Default → Path B** | **15.4pp** | Make iOS card_number OCR extract reliably on real-device captures |
| Path B → Path A | 1.3pp | Better set_hint extraction (mostly tapped out post-Phase-1) |
| Path A → 100% | 4.0pp | Better embedder (SigLIP-2 fine-tune or model swap) |

**The 15.4pp gap is still the dominant lever** — narrower than the
22.3pp pre-backfill but the OCR-robustness work remains the highest
real-device ROI. When OCR card_number fires correctly, we're at
~95% regardless of set_hint. When it doesn't, we're at 79%.

The eval also surfaced the HIGH-confidence-rate signal that drove
the user's "first-time HIGH feels low" observation: **Path B run
shows 267/323 = 82.7% HIGH** (with perfect OCR card_number, post
Phase 1). That's the realistic upper bound on first-try HIGH-rate
assuming OCR fires. Real-device OCR isn't 100% — Phase 2 (multi-frame
consensus on tap) is the lever to close the gap between real-device
OCR and this ceiling.

### What Tier 1.1 actually shipped (and didn't)

Real-device 2026-05-07 evidence drove four iterations in one
day. Net-net what's on shipping builds:

| Stage | Commit | Status | Effect |
|---|---|---|---|
| 1 — Multi-pass fallback | `8cad899` | ✅ shipped, verified | Pass-2 retries OCR without spatial filter when pass-1 returns empty. Real-device: 8 of 9 fallback firings recovered the correct card_number. |
| 2 — Strip-pass ratio 0.18 → 0.25 | `8cad899` | ✅ shipped | Captures card_numbers in the 18-25% band that the narrower strip missed. |
| 3 — Perspective correction | `053a9a9` | ✅ shipped (with known coord quirk) | Cards now consistently render in portrait orientation post-correction; CIPerspectiveCorrection unwraps any rotation/skew. **However** — Vision's spatial filter rejects card_numbers on the corrected image (Mode 8 in failure-modes log) due to a coord-system interaction we haven't fully diagnosed. Pass-2 fallback handles it gracefully. |
| 3.1 — Y-flip on perspective output | `b6e18b5` then `feda9fa` | ❌ **REVERTED** same day | Misdiagnosed Mode 8 as upside-down rendering and applied a Y-flip transform — actually horizontally MIRRORED the output. Vision started reading reversed text (`noitzudmo)` for "(Combustion"). Reverted. |

**End-to-end Tier 1.1 outcome on real device:** card_numbers extract
reliably via pass-2 fallback. HIGH-confidence top-1 on most cards
where the embedder already sees them. The Default→Path B gap is
*partially* closed — not by getting pass-1 to fire, but by getting
pass-2 to recover what pass-1 misses. Cosmetic ergonomic
distinction; not a user-facing accuracy issue.

### Critical lesson from the stage 3.1 revert

**Don't ship a coord-system fix without first verifying the coord
convention empirically.** I reasoned analytically across three
overlapping coord systems (CIImage bottom-left, CGImage top-left,
Vision normalized) and got a subtle interaction wrong. The fix
shipped, broke text rendering immediately, and was reverted within
the same day.

The right sequencing for any Mode 8 follow-up:
1. Add diagnostic instrumentation FIRST — log the input
   quadrilateral corners, the output extent, and one observation's
   raw boundingBox values for a known scan.
2. Save the post-correction image to a known path so we can
   visually inspect orientation.
3. ONLY THEN write the fix, with concrete data backing the
   transform we apply.

This pattern (diagnostic-then-fix) is now the default for any
coord-system or rendering work. Documented in
`scanner-ocr-failure-modes.md` Mode 8 status.

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

## 3. Current priority queue (post 2026-05-07 evening)

### Tier 1 — Mostly shipped

#### 1.1 Card_number OCR robustness on real-device — ✅ shipped (parts a, b, c)

Sub-levers and their status:

**a. Orientation-aware spatial filter.** ⚠ **Partial — Mode 8
remaining.** Stage 3 (`053a9a9`) shipped CIPerspectiveCorrection
which handles the underlying problem (sideways/rotated cards) at
the embedder layer. Stage 3.1 attempted to also fix the OCR-side
spatial-filter rejection caused by the perspective output's
coord-system quirk, but the Y-flip fix mis-modeled the
interaction and was reverted (`b6e18b5` → `feda9fa`).

  **Current state**: pass-2 fallback (stage 1) handles the
  spatial-filter rejection gracefully — 8 of 9 fallback firings
  on the 28-scan baseline recovered the correct card_number.
  Cosmetic pass-1-vs-pass-2 distinction; not a user-facing
  accuracy gap.

  **Proper Mode 8 fix is deferred** until we add diagnostic
  instrumentation (see Tier 1.5 below). Don't attempt another
  coord-system transform until we have empirical evidence of the
  actual coord convention being used.

**b. Multi-pass with retries.** ✅ shipped (`8cad899`). Verified
8/9 success rate on real device.

**c. Strip-pass tuning.** ✅ shipped (`8cad899`). Bumped 0.18 →
0.25; captures card_numbers in the 18-25% band that the narrower
strip missed.

**d. Image quality gates.** ⏸ **Deferred.** Real-device data
shows Mode 6 (Vision sees no slash-text at all) accounts for
~43% of scans — but the kNN was strong enough to win HIGH
confidence on most of those without the card_number signal.
Lower priority than originally planned. Revisit if real-device
top-1 plateau emerges.

#### 1.5 Diagnostic telemetry — ✅ shipped 2026-05-08 (Phase 0a/b/c)

Two-surface telemetry foundation complete:

**Server-routed scans (free-tier + offline-miss fallback)** — DB
columns added to `scan_identify_events` via migration
`20260508000000_scan_identify_events_ocr_diagnostics.sql`:
- `ocr_card_number_extracted: bool`
- `ocr_pass2_fallback_fired: bool`
- `ocr_spatial_filter_rejected_count: int`

iOS sends these as query params on `/api/scan/identify`; the route
parses and persists them via `logScanEvent` (commit d7f6d30).

**Offline scans (feature-gated path)** — PostHog `card_scanned`
event emitted from `ScannerHost.runIdentify` on every scan
completion (success AND error paths). Properties cover the full
diagnostic surface plus winning_path / confidence / top_match_slug /
top_similarity / ocr_frames_used so we can segment the Phase 2
multi-frame impact in PostHog without comparing deploys (commit
60196ff).

Aggregate queries now answerable from PostHog within a day of
real-device usage:
- "What % of scans returned HIGH on first try, segmented by
  trigger_source (auto-detect / tap / tap_multiframe)?"
- "What fraction of medium-confidence scans had cardNumbers=[]?"
  (the Mode 6 prevalence question)
- "Does pass2_fallback_fired correlate with confidence outcome?"
- "What's the spatial_filter_rejected_count distribution and does
  it predict failure modes?"

**Phase 0d (perspective-correction extent telemetry) ✅ shipped 2026-05-15.**
The saved-image side of "saved-image inspection harness for Mode 8"
landed earlier across multiple commits — `ScanDebugCapture` saves
the post-perspective UIImage to Photos with a diagnostic banner
(DEBUG-only, every scan including HIGH), and the server-routed
review queue captures the same images to
`scan-uploads/review-queue/<hash>.jpg`. The missing piece — the
numeric corner / extent / portrait-rotation geometry that
`croppedToCard` produces — now lands as a structured
`PerspectiveCorrectionDiagnostics` value:

- Server-routed scans: JSON query param on `/api/scan/identify` →
  `scan_identify_events.ocr_perspective_corrected_extent` (jsonb,
  migration `20260515200000`).
- Offline scans: flat-keyed properties on PostHog `card_scanned`
  (`ocr_perspective_corrected`, `ocr_perspective_portrait_rotation_applied`,
  `ocr_perspective_input_w/h`, `ocr_perspective_output_w/h`).
- DEBUG builds: an extra `persp:` line on the Photos-library banner
  showing input size, output size, portrait rotation flag, and
  normalized input corners.

**Mode 8 proper fix remains deferred** until ~10–20 real-device
samples land in the new column — the stage-3.1 revert lesson is
binding here. Don't ship another coord-system transform until the
empirical orientation/extent distribution justifies the math.

#### 1.6 Trust-killer sim-floor refinement on `ocr_intersect_unique` — ✅ shipped 2026-05-08

Real-device 2026-05-07 evidence (28-scan baseline) showed 5
scans hit `ocr_intersect_unique` with the right answer but
stayed at `confidence=medium`. Examples:

```
Naclstack #83  ocr_intersect_unique sim=0.842 → medium
Hippowdon #53  ocr_intersect_unique sim=0.834 → medium
Kleavor #85    ocr_intersect_unique sim=0.764 → medium
```

**Actual mechanism (verified 2026-05-08 by reading the code).**
Not an absolute sim threshold — the trust-killer at
`route.ts:1364-1368` and `OfflineIdentifier.swift:367-392`
demoted to MEDIUM whenever Path B's promoted slug ≠ kNN top-1,
regardless of how strong the kNN sim was. Original rationale
(5f2df4f, 2026-04-29): defend Umbreon V → Suicune & Entei
LEGEND #94 false-positive where OCR `card_number=94` pulled an
unrelated card from a different set/era to the top.

**Fix shipped 2026-05-08 (this session).** Trust-killer now also
gates on visual-sim weakness: only demotes when the promoted
slug has `cos_dist > CONFIDENCE_HIGH_COS_DIST` (= sim < 0.75).
At sim ≥ 0.75 (the same HIGH-eligibility floor Path C uses),
OCR card_number + visual top-K membership are two independent
signals confirming the same answer → HIGH. The Umbreon →
wrong-set false-positive sits well below 0.75 (different sets,
different eras visually unrelated) so the original defense
still catches it.

**Expected impact.** Real-device first-time-HIGH rate +5–10pp.
Eval scoreboard percentages unchanged (eval counts top-1
correctness, not confidence tier — and top-1 doesn't flip,
only the tier does). Confidence-tier distribution within the
eval `detailed_results` should show fewer correct-but-MEDIUM
rows on the Path B ceiling run.

**Validation.** Re-run the 3-mode eval after deploy. Look at
`scan_eval_runs.detailed_results` for any per-image
correct→wrong flips. Real-device smoke session is the ultimate
proof of the user-facing lift.

#### 1.7 Full-art auto-capture trigger via saliency fallback — ✅ shipped 2026-05-16

**The gap this closes.** Not visible in the eval scoreboard at
all — the eval harness feeds the identify route directly and
never tests the iOS capture trigger. User-facing problem: full-
art / VMax / VSTAR / ex cards never auto-fire because
`VNDetectRectanglesRequest` needs an edge gradient between card
and background, and the artwork on these cards bleeds to the
border. Tap-to-capture worked as an escape hatch, but the
auto-capture experience was "scanner doesn't recognize the card"
from the user's perspective.

**Mechanism (shipped 2026-05-16).** When the rectangle detector
has produced no observation for `saliencyFallbackDelay` (1.5s),
the engine runs `VNGenerateAttentionBasedSaliencyImageRequest`
on the same pixel buffer. The largest salient region — sanity-
gated on aspect ratio (∈ [0.45, 0.95]) and short side (≥ 25%
of frame) — accumulates stability the same way a rectangle
candidate does, and fires the existing `didDetectStableCard`
delegate with `triggerKind: "auto_saliency"`. Implementation in
`PopAlphaVisionEngine.analyzeSaliency`.

Containment against false-fires on clean surfaces:
1. Aspect/size sanity rejects most non-card salient regions
   before any network call.
2. Existing server confidence threshold → LOW on non-cards →
   silent re-arm. No user disruption.
3. 8s wall-clock cooldown after each saliency fire. NOT cleared
   by `reset()` (which runs on LOW silent re-arm), so the
   phone-on-desk loop runs at most every 8s instead of every
   2s. Mode 9 in `scanner-ocr-failure-modes.md` carries the
   full diagnosis.

**Telemetry.** `triggerSource: "auto_saliency"` flows through
PostHog `card_scanned` and `scan_identify_events.trigger_source`
unchanged. Segment hit-rate / HIGH-rate vs. `"auto"` baseline
once a few days of real-device traffic accrues.

**Validation.** Real-device smoke is the binding signal:
- Normal cards: time-to-trigger unchanged (target ≤1s, same
  rectangle-stability gate as before).
- Full-art / VMax / VSTAR / ex / Illustration Rare: auto-fire
  within ~2.5s, top-1 correct at the rate the embedder already
  achieves on these (~80% from Default-mode eval).
- Empty scenes (desk, hand, ceiling): no auto-fire (sanity gate).
- Mid-scan motion: trigger does not fire during motion (stability
  gate).

Eval harness numbers should NOT change — re-running it after this
PR is a regression-guard, not a lift measurement.

#### 1.2 Multi-frame consensus on tap — ✅ shipped 2026-05-08 (v1)

Tap path captures 3 frames spaced ~200ms apart (total ~400ms wait),
runs OCR on all of them concurrently via `withTaskGroup`, votes on
card_number candidates by frequency, and feeds the voted list to the
orchestrator's `identifyMulti` trial loop. Single-frame fragility
under motion blur / glare / hand tremor is the primary failure mode
this addresses — when one frame misreads `068` as `163`, two other
frames typically read it correctly and the vote wins.

**v1 scope (shipped commits 7b48193).**
- 3 frames, 200ms inter-frame, sequential capture (the video pipeline
  writes a fresh pixelBuffer at ~60fps so successive
  `captureCurrentFrame` calls return distinct frames).
- Per-frame OCR runs concurrently via `withTaskGroup` — no 3x
  latency penalty on the OCR cost.
- Embedding still uses the first frame. The card hasn't moved in
  400ms; first-frame embedding matches the multi-frame OCR consensus
  to within sub-pixel motion. Avoids the embedding-averaging
  complexity for v1.
- Auto-detect and library paths stay single-frame: auto-detect is
  already async + low-friction, library has only one image.

**v2 deferred ideas (not blocking).**
- Average embeddings across frames (technically tighter sim, marginal
  in practice — first-frame is fine until eval shows otherwise).
- Early termination: stop after 2 frames agree at HIGH confidence
  (saves ~200ms when the first capture is already clean; complicates
  the loop).
- Sharpness-based frame selection for embedding (Laplacian variance).

**Latency:** end-to-end tap goes from ~270ms (single-frame) to
~670ms (multi-frame). Within the user's "I tapped, give me a result"
expectation; lift in HIGH-rate is worth the wait.

**Validation.** TestFlight build required — eval harness is
server-side and can't model multi-frame capture. Phone smoke session
should compare same-card scans with multiple captures: HIGH-rate on
first scan should rise meaningfully, and the
`Logger.scan.debug "ocr multiframe frames=N voted_card_numbers=..."`
log should show consensus voting in action.

**Expected real-device impact:** +3 to +8pp top-1 on tap scans, plus
a meaningful HIGH-rate lift via Phase 1's sim-floor refinement
firing more often (more reliable card_numbers → more
ocr_intersect_unique HIGH cases).

### Tier 2 — Medium ROI, weeks

#### 2.1 SigLIP-2 fine-tune on user-correction corpus

The 4.3pp Path A → 100% gap is genuinely "the embedder confuses
these cards." We collect ground-truth corrections via
`source='user_correction'` rows in `card_image_embeddings`.
Fine-tune SigLIP-2 on those + the eval corpus.

Cost: $50–200 compute, 1–2 weeks of work, plus deployment plumbing
for the new model_version. See `scanner-finetune-runbook.md` for
the procedure.

**Gating criteria updated post-2026-05-21 baseline:**
- Original rule was "fire only at ~88-90% real-device top-1".
- We're at 75.5% real-device top-1 (set-specific to Journey
  Together) — still below the threshold.
- BUT the §0 baseline shows **the remaining error mode is now
  cross-set confusion, not OCR robustness.** Tier 1's OCR work
  cannot lift Default→Path B further on the 11 cross-set wrongs
  because the OCR was either right or absent; the embedder picked
  the wrong set.
- **Revised rule**: fire the fine-tune once we have ≥150-200
  user-correction pairs covering ≥3 sets, even if real-device top-1
  is still in the high 70s / low 80s. The targeted lift on
  cross-set false-attractors should be larger than the historical
  2–4pp because we'd be training directly on the measured failure
  mode. **Each set-specific baseline session adds ~10-20 high-
  quality pairs** — Journey Together's 13 are the first batch.

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

## 4.5. "Looks like a scanner bug, isn't" — adjacent-system failures

Not every "the scanner doesn't work right" report is a scanner
problem. When triaging a real-device complaint, **check the
catalog and pricing pipelines before assuming the issue is in
OCR / kNN / confidence logic**. Some classes of issues that
masquerade as scanner failures:

### Pattern 1 — Card identifies but shows $0.00

**User-visible symptom**: scan returns a correct top-1 match
but the card-detail view shows `$0.00`, or "—", or no price.

**Likely root cause**: `public_card_metrics` has no row (or a
null `market_price`) for that slug. The scanner's job ends at
canonical_slug; the price displayed is downstream.

**How to diagnose** (read-only, ~2 minutes):
```sql
-- Does the slug have a metrics row at all?
select canonical_slug, market_price, market_price_as_of, market_price_source
from public.public_card_metrics
where canonical_slug = '<slug-from-the-bad-scan>';

-- Does the SET have any priced rows?
select count(*) from public.public_card_metrics
where canonical_slug like '<set-slug>-%' and market_price is not null;
```
Zero priced rows for the whole set ≈ the ingestion pipeline
hasn't priced this set yet. Compare to a known-priced set
(`mega-evolution-%`, `prismatic-evolutions-%`) for control.

**Where the fix lives**: `docs/ingestion-pipeline-playbook.md`,
not here. Hand off to the ingestion specialist with the slug
and the diagnostic counts.

**Real-device example 2026-05-07**: user scanned a Perfect Order
card, scan returned correct top-1, price showed $0.00.
Investigation showed:
- `canonical_cards` for `perfect-order-%`: 124 rows ✓
- `card_image_embeddings` siglip+full: 126 distinct slugs ✓
- `public_card_metrics` for `perfect-order-%`: **0 rows** ← bug
- Compare `mega-evolution-%`: 555 priced rows.

The scanner side was complete; the pricing pipeline simply
hadn't onboarded Perfect Order. Routed to ingestion track —
the scanner workstream did not need any change.

### Pattern 2 — Scan returns "wrong" set but the visual is similar

**User-visible symptom**: scan returns a Mega Evolution Charizard
but the user scanned a 151 Charizard (or vice versa).

**Likely root cause**: kNN is doing exactly what it's supposed
to — finding the visually-most-similar card. When the same
artwork prints across multiple sets (reprints, cross-set
promos), kNN can't distinguish them from image alone. Path B
disambiguation (card_number) is the lever. If
`cardNumbers=[]`, this is the failure mode.

**Diagnostic**: look at the scan's `tried_candidates` field. If
it's `[]`, OCR didn't get a card_number. If it's `[N]` and
Path B unique-matched the wrong slug, there's a real
mis-identification. Check `winning_path` — `vision_only`
means kNN-only; `ocr_intersect_unique` means card_number
disambiguated.

**Where the fix lives**: depends. If Mode 6 (no slash-text
seen), Tier 1.1.d image quality gates may help. If `cardNumbers`
populated but Path B still wrong, that's a real OCR-error case
worth a Mode 7 entry in the failure-modes log.

### Pattern 3 — Scan fails for an entire set

**User-visible symptom**: every card from set X scans wrong or
returns LOW confidence.

**Likely root causes** (in priority order to check):
1. **Coverage gap** — `canonical_cards` doesn't have the set yet.
   Query: `select count(*) from canonical_cards where set_name = '<set>'`.
2. **Embedding gap** — canonical rows exist but no SigLIP
   embeddings. Query: `select count(*) from card_image_embeddings
   where canonical_slug like '<set-slug>-%' and model_version =
   'siglip2-base-patch16-384-v1'`.
3. **All canonical rows tagged digital_only=true** — the
   identify route's KNN_QUERY filters
   `is_digital_only = false`, so a digital-only-tagged set
   would return zero candidates.
4. **All canonical rows tagged is_digital=true** in
   canonical_cards — similar effect via a different filter.
5. Genuine SigLIP confusion on a hard art style.

The first 4 are catalog/ingestion issues, not scanner issues.

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

## 7. Roll-up — the one-paragraph version (post 2026-05-15)

Tier 1.1's substantive parts shipped: multi-pass fallback +
strip-pass tuning + perspective correction. Tier 1.5 ALL phases
shipped between 2026-05-08 and 2026-05-15: OCR diagnostic
telemetry (Phase 0a/b/c), failure-case review queue (§6),
eval-corpus auto-promote (Phase 0d test-loop), and
perspective-correction extent telemetry (Phase 0d Mode 8
prerequisite). Tier 1.6 (HIGH-conf trust-killer refinement)
shipped 2026-05-08. Phase 1.5 HIGH-gate tuning shipped 2026-05-13.

Stage 3.1 (Y-flip) was attempted 2026-05-07 to "fix" the
spatial-filter quirk on perspective-corrected output, mis-modeled
the coord-system interaction, broke text rendering immediately
(mirrored output), and was reverted. **Lesson logged: don't ship
coord-system fixes before adding diagnostic instrumentation.**

**The next priority is the Mode 8 coord-system fix**, but it's
gated on ~10–20 real-device samples landing in the new
`scan_identify_events.ocr_perspective_corrected_extent` column
and the equivalent PostHog properties on offline scans. Once
that data is in hand, write the coord transform against
empirical evidence instead of guessing (stage-3.1 lesson). In
parallel, the failure-modes scoreboard in
`scanner-ocr-failure-modes.md` is overdue for a refresh from the
~7 days of telemetry already in PostHog and `scan_identify_events`
— that population should also inform which Tier-1 lever is the
actual dominant remaining lever, vs. whether we've hit the 88–90%
real-device top-1 threshold that gates Tier 2 (SigLIP-2 fine-tune)
and multi-scan mode.

**Important triage rule when something looks broken**: §4.5
catalogs failure patterns where a "scanner bug" report is
actually a catalog/pricing-pipeline bug. The Perfect Order
scanned-but-priced-at-$0.00 case from 2026-05-07 is the
canonical example — the scanner did its job perfectly; the
ingestion pipeline hadn't priced the set yet. Always run the
catalog/pricing diagnostic queries before diving into the OCR
or kNN code.
