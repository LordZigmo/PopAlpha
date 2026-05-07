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

## 1. Where we are (post-Tier-1.1, 2026-05-07)

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
set_hint. When it doesn't, we're at 72%.

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

#### 1.5 Diagnostic telemetry (NEW, NOW HIGHEST PRIORITY)

Promoted from "future polish" to **next active workstream** after
the stage 3.1 revert. Two reasons:

1. **Mode 8 needs empirical instrumentation before any further
   fix attempt.** Specifically: log the input quadrilateral
   corners, the perspective-correction output extent, and one
   sample observation's raw boundingBox values for each scan
   (or each scan when DEBUG flag is on). Save the
   post-correction image to scan_uploads with a known prefix
   so it can be visually inspected. From this data the actual
   coord-system behavior becomes obvious.

2. **Real-device aggregate metrics are missing.** We've been
   reasoning from ~30-scan smoke samples. Add to
   `scan_identify_events`:
   - `ocr_card_number_extracted: bool` — did we get any
     card_number candidates?
   - `ocr_pass2_fallback_fired: bool` — did pass-1 reject and
     pass-2 recover?
   - `ocr_spatial_filter_rejected_count: int` — how many
     slash-line observations did the spatial filter reject?
   - `ocr_perspective_corrected_extent: jsonb` — debug-only,
     the corner points + output extent for one observation per
     scan.

   Aggregated weekly, this tells us whether the failure modes
   we've been chasing are 5% of scans or 50%, and prioritizes
   accordingly.

**Estimated effort:** ~half-day for the telemetry, ~half-day
for the saved-image inspection harness. Total ~1 day.

#### 1.6 HIGH-confidence threshold review on `ocr_intersect_unique`

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

## 7. Roll-up — the one-paragraph version (post 2026-05-07 evening)

Tier 1.1's substantive parts shipped: multi-pass fallback +
strip-pass tuning + perspective correction. Real-device data on
~30 scans confirms pass-2 fallback recovers 8 of 9
spatial-filter rejections, perspective correction puts the card
in portrait orientation reliably, and end-to-end HIGH-confidence
top-1 is the norm on cards where the embedder sees them clearly.
Stage 3.1 (Y-flip) was attempted same-day to "fix" the
spatial-filter quirk on perspective-corrected output, mis-modeled
the coord-system interaction, broke text rendering immediately
(mirrored output), and was reverted. **Lesson logged: don't ship
coord-system fixes before adding diagnostic instrumentation.**

The next priority is no longer "more OCR robustness" — it's
**Tier 1.5 telemetry** (saved-image inspection harness +
`scan_identify_events` field augmentation). Without that, we
keep operating from 30-scan smoke samples and shipping fixes
that turn out to be misdiagnosed (stage 3.1) or out-of-priority
(image quality gates that wouldn't have helped because Mode 6
wasn't actually the dominant failure). After Tier 1.5 lands,
Mode 8 (perspective coord quirk) gets a proper fix and we
re-baseline. **In parallel**, Tier 1.6 (HIGH-confidence
threshold review on `ocr_intersect_unique`) is a half-day
mechanical fix: when OCR card_number AND kNN top-1 agree on a
unique slug, it should be HIGH regardless of absolute sim. Real
device showed 5 of 28 scans were medium-but-correct because the
threshold was too conservative — easy lift.

**Important triage rule when something looks broken**: §4.5
catalogs failure patterns where a "scanner bug" report is
actually a catalog/pricing-pipeline bug. The Perfect Order
scanned-but-priced-at-$0.00 case from 2026-05-07 is the
canonical example — the scanner did its job perfectly; the
ingestion pipeline hadn't priced the set yet. Always run the
catalog/pricing diagnostic queries before diving into the OCR
or kNN code.
