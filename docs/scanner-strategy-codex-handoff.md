# Scanner strategy — Codex evaluation handoff

> **Purpose.** Ask Codex to evaluate whether our current scanner-
> accuracy strategy is the right next move given the first
> verified-correctness data we've ever measured (2026-05-21). This
> is a strategic review, not a code review.

---

## What the scanner does (60-second version)

PopAlpha is an iOS app that identifies Pokémon TCG cards from the
camera. Two identification paths share a SigLIP-2 image-embedding
catalog (~26k canonical card slugs, ~232k storage images):

1. **Offline (premium):** on-device kNN over a bundled SigLIP-2
   catalog in `OfflineScanOrchestrator.swift`. Dominant path.
2. **Server-routed (free + offline-miss fallback):**
   `/api/scan/identify` runs pgvector kNN + an OCR-card_number
   narrowing step (Paths A/B/C). Almost dormant — server-routed
   traffic dropped to ~zero on 2026-05-08.

OCR runs via Apple Vision on a perspective-corrected card crop
(`PopAlphaVisionEngine.croppedToCard`). The card_number is used to
narrow kNN top-K to slugs that have a matching `card_number` in
`canonical_cards`. When OCR fires correctly, Path B
("ocr_intersect_unique"/"_narrow") narrows to a single answer and
the result is HIGH confidence. When OCR doesn't extract a number,
the system falls through to Path C ("vision_only" = kNN top-1
alone).

Multi-scan mode (shipped 2026-05): tap the bottom-right toggle,
auto-detect appends each card to a review tray, swipe-left → Edit
opens a picker to correct any wrong row, tap Add to bulk-import
to the user's portfolio.

---

## Where we were before this session

| Eval mode | Top-1 (323 labeled images, server-side) |
|---|---|
| Default (kNN only, no OCR) | 79.3% |
| Path B ceiling (perfect OCR card_number) | 94.7% |
| Path A ceiling (perfect OCR + set_hint) | 96.0% |

Operating thesis until 2026-05-21:

> **"The dominant accuracy lever is OCR card_number robustness on
> real-device captures, not model improvements."**

This came from the 15.4pp Default→Path B gap above. If OCR fires
reliably, we hit ~95%. The Tier 1 work (multi-pass OCR fallback,
strip-pass tuning, perspective correction, multi-frame consensus,
trust-killer sim-floor) all addresses that gap.

**But this thesis was never tested against real-device verified-
correctness data.** Until 2026-05-21, we only had:
- The 323-image eval (server-side, controlled images, no iOS OCR)
- PostHog `card_scanned` tier distributions (claimed-HIGH-rate,
  not verified correctness)

---

## What changed: first real-device verified-correctness baseline

Methodology: solo user (zach@popalpha.ai) ran a 53-scan multi-scan
session 2026-05-21T22:41–22:50 UTC, deliberately reviewed every
tray row before submit, swiped-Edit any wrong row. Uncorrected
rows treated as user-accepted = ground truth. (Safe only in this
solo-deliberate-review case — see
`scanner-ocr-failure-modes.md` Caveats.)

**Setup:** 100% Journey Together (recent set, fully SigLIP-embedded,
fully priced).

**Headline numbers:**

| Metric | Value |
|---|---|
| Top-1 correctness | **40/53 = 75.5%** |
| HIGH precision | 21/24 = 87.5% |
| MEDIUM precision | 19/29 = 65.5% |
| HIGH-wrong rate | 3/53 = 5.7% |
| OCR extraction rate | 35/53 = 66.0% |
| Mode 6 prevalence (Vision saw no slash-text) | 28.3% |
| Pass-2 fallback fired (Mode 8 path) | 100% of extractions |

**The dominant remaining error mode is cross-set confusion, not
OCR.** Of the 13 corrections:

- **11/13 (85%) picked top-1 from a *different set* than the user's
  card.** Only 2 were intra-set slug confusions.
- Two specific slugs act as repeated false-attractors:
  - `perfect-order-84-rosa's-encouragement` (pulled top-1 on 2
    unrelated Journey Together scans)
  - `prismatic-evolutions-53-hippowdon` (pulled top-1 on 2
    unrelated Journey Together scans)
- 3/3 HIGH-wrong cases were `vision_only` winning_path (kNN-only,
  no OCR card_number to disambiguate). All 3 share visual style /
  layout with the user-correct slug.

For an OCR-side intervention to fix the cross-set wrongs, OCR
would need to fire on the *card_number* AND that card_number would
need to disambiguate the kNN top-K. On vision_only HIGH cases, OCR
returned no card_number (Mode 6) — so even perfect OCR can't
close those cases unless we lower the bar for what counts as a
"good enough" OCR signal (risky).

The embedder is what picked the wrong set. Closing this gap is an
embedder-side problem.

---

## The current strategic queue (post-baseline)

Updated in `scanner-accuracy-playbook.md` §0 (new) + §2.1
(revised gating criteria). Summary:

**Tier 1 (mostly shipped):**
- ✅ Tier 1.1 — multi-pass OCR fallback + perspective correction
- ✅ Tier 1.5 — diagnostic telemetry (PostHog `card_scanned`
  properties, `scan_identify_events` columns, Phase 0d perspective
  extent)
- ✅ Tier 1.6 — trust-killer sim-floor on `ocr_intersect_unique`
- ✅ Tier 1.2 — multi-frame consensus on tap
- 🟡 **NEW: Tier 1.7 — sim-gap-aware HIGH gate for `vision_only`
  cases.** The 3 HIGH-wrong cases this session were all vision_only.
  The trust-killer demote only fires when Path B's promoted slug ≠
  kNN top-1, but vision_only has no Path B promotion. **Proposal:
  for vision_only, require sim-gap-to-rank-2 ≥ some threshold to
  earn HIGH; otherwise demote to MEDIUM (which would route to the
  picker).** Threshold needs telemetry to set — the current
  PostHog `top_similarity` + `top_gap_to_rank_2` columns expose it.

**Tier 2 (deferred — gating revised):**
- 🟡 **Tier 2.1 — SigLIP-2 fine-tune.** Original gate was "real-
  device top-1 ≥ 88-90%". We're at 75.5%. But the §0 finding
  suggests the gating logic itself is wrong: the remaining error
  mode is now precisely what fine-tune fixes (cross-set
  confusion), and Tier 1 can't move the needle further on those
  errors. **Revised proposed gate: ≥150-200 user-correction
  pairs covering ≥3 sets, even if real-device top-1 is in the
  high 70s.** Each smoke session on a new set adds ~10-20 pairs.

**Tier 3 (speculative):**
- Mode 8 coord-system fix (sample gate now met, but
  diagnostic-then-fix rule binds)
- RFDETR supplemental classifier
- JP scoreboard

---

## What I want Codex to evaluate

Specific questions, not "tell me what to do":

1. **Is the Tier 2 gating revision sound?** Original rule: fire
   the fine-tune at 88-90% real-device top-1. Proposed new rule:
   fire it at ≥150-200 correction pairs covering ≥3 sets. The
   argument is that the remaining errors are now structural
   (embedder cross-set confusion) rather than the OCR-robustness
   class that Tier 1 was designed for. **Is this argument
   correct, or am I over-rotating on N=53 from a single set?**

2. **Is Tier 1.7 worth doing before Tier 2?** The proposed
   sim-gap-aware HIGH gate for `vision_only` would only catch 3
   HIGH-wrong cases out of 53 (5.7%) — but those are the worst
   user-facing failures. **Is this a cheap pre-fine-tune win, or
   is it tuning around the embedder problem rather than fixing
   it?**

3. **Set-distribution effect — what's the right way to disentangle
   it?** The Journey Together 75.5% is probably high relative to
   a heterogeneous mix. Repeating on Surging Sparks or Prismatic
   Evolutions (where the false-attractor lives) gives 1 more data
   point per session, ~10-20 corrections each. **How many
   different sets / how many total corrections do we need before
   we can claim a real per-app correctness number with confidence
   interval?**

4. **Is the cross-set-confusion finding solid, or could it be an
   artifact of how I set up the methodology?** Specifically:
   - Could the picker UI bias toward "search the catalog" over
     "pick from top-3" if the top-3 results are visually similar
     to the correct card? (i.e., maybe the right card WAS in
     the top-3 but the user didn't recognize it at a glance)
   - The 11/13 cross-set rate matches what we'd expect if SigLIP
     confuses templates (stadium cards, full-art ex/VSTAR, small
     mammals) — but we haven't pulled the sim scores for those
     specific events to verify the gap was wide. Worth pulling
     `top_similarity` and `rank_2_similarity` for the 13
     correction events to see if there's a tightness pattern.

5. **Is "vision_only HIGH-wrong" worth treating as its own
   failure mode in `scanner-ocr-failure-modes.md`?** I haven't
   added it as Mode 11 yet because all 3 cases share the same
   underlying cause (embedder cross-set confusion) — but the
   user-facing signature is distinctive (HIGH confidence, no
   picker shown, wrong card silently added to tray) and might
   warrant its own catalog entry.

---

## Anti-questions (don't spend time here)

- Don't propose more OCR tuning. The data shows OCR is no longer
  the bottleneck on this set.
- Don't propose more rectangle-detector tuning. Already at
  minimumConfidence=0.70.
- Don't propose disabling saliency entirely. PR #114 already
  gates it correctly per-mode; the residual 1.9% saliency rate is
  fine.
- Don't propose changes that require a new Vision request type
  (`VNDetectDocumentSegmentationRequest`, foreground segmentation,
  etc.). Same edge-gradient failure mode as rectangles.
- Don't propose Mode 8 coord-system fix before diagnostic-then-fix
  has run. The stage 3.1 revert is the binding precedent.

---

## Data the reviewer can pull

- PostHog project `PopAlpha iOS` (id 391820) — `card_scanned` and
  `scanner_multi_mode_row_corrected` events. Session window:
  `timestamp >= '2026-05-21 00:00:00'` filters to this session
  cleanly (no other devices active in that window).
- Supabase `scan_eval_images` rows where `captured_source =
  'user_correction'` AND `created_at >= '2026-05-21'` — the 13
  ground-truth pairs (image hash + canonical slug).
- `card_image_embeddings` rows where `source = 'user_correction'`
  — the kNN anchor side of those same 13 pairs.

---

## TL;DR for Codex

We measured real-device top-1 correctness for the first time
(75.5% on a single recent set). The remaining errors look
embedder-side (cross-set confusion), not OCR-side. We want to
shift from Tier 1 OCR work to Tier 2 SigLIP-2 fine-tune sooner
than the original 88-90% gate suggested. **Validate the shift
or push back.**
