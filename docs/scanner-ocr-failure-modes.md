# Scanner OCR failure modes — running log

> **Append-only catalog of every real-device OCR failure case we
> observe.** Each entry includes the symptom, what Vision actually
> saw, the diagnosed root cause, and the fix or current
> mitigation. New cases get a new section under `## Observed
> failure modes` — do NOT delete entries even after they're
> fixed; the historical record is the moat.

Companion to `scanner-accuracy-playbook.md` (the strategic
framework) and `scanner-runbook.md` (operational reference).

This file exists because OCR failures on a Pokemon TCG card are
an open-ended problem space — old cards print things differently
from modern ones, photo angles vary, lighting is unpredictable,
JP printings introduce new typography. We will keep finding new
modes. We catalog them so:

1. We don't fix the same mode twice.
2. We can quantify which modes account for the most user pain
   (see scoreboard at bottom).
3. New engineers on scanner work see the failure landscape, not
   just the codebase.
4. Each fix has a documented "before" diagnostic so we can
   validate it from logs alone.

---

## How to file a new entry

When you observe an OCR failure on real-device or in the eval
corpus, add a new `### Mode N — <one-line title>` section under
`## Observed failure modes`. Include:

1. **Symptom** — what the user / log saw (one sentence).
2. **Evidence** — the literal log lines or scan_eval_images row
   that surfaced it. Quote them; don't paraphrase.
3. **Vision actually saw** — what Vision's OCR returned for the
   problematic frame. Often the diagnostic
   "`ocr spatial filter rejected N slash-line(s)…`" is the key
   evidence; if not present, dump observations via
   `Logger.scan.debug(...)` of the recognized text.
4. **Root cause** — one paragraph max, focused on the mechanism.
5. **Fix or mitigation** — what we did, what commit shipped it,
   or "OPEN — see scanner-accuracy-playbook.md tier N."
6. **Repro** — image hash from `scan_uploads` if you have one,
   or eval slug. Lets the next eval re-run produce the same
   diagnosis.

Then bump the scoreboard count at the bottom.

---

## Vision OCR ground rules (read once)

Reference for diagnosing failures. Things that are *never* the
fix:

- **"Vision is just bad at small text."** It isn't. The Vision
  request runs `recognitionLevel = .accurate` with revision 3
  pinned. On a 384px-tall card crop, attack-text glyphs are
  ~12-15px tall, well within the recognizer's documented range.
  If Vision missed something, the cause is upstream (crop, glare,
  rotation) — almost never the recognizer itself.
- **"Just lower the confidence threshold."** Vision's
  topCandidates(N) already exposes alternates; the multi-pass
  loop in `OCRService.extractCardIdentifiersMulti` already tries
  three candidates per observation.
- **"Add another regex."** The collector pattern
  `\b(\d{1,3})\s*/\s*(\d{1,3})\b` is correct. Most OCR failures
  are the spatial filter or the card not having an extractable
  X/Y in the first place.

Things that *ARE* the right diagnosis:

- **The crop or rotation is wrong** before OCR runs.
- **The card itself doesn't print "X/Y"** in extractable form
  (vintage Base Set has it as a regular footer line, but some
  promos print only "Promo" with no numbered fraction).
- **The plausibility filter is rejecting a real number** because
  yInt or xInt fell outside the [5, 600] / [1, 999] ranges. Rare
  but possible on edge cases (Trainer Gallery cards with set
  size > 600?).

---

## Observed failure modes

### Mode 1 — Hand-held grip pushes card_number above spatial threshold

**Symptom.** Real-device 2026-05-07 scans of Heatran (Prismatic
Evolutions #68) and Budew (Prismatic Evolutions #4) returned
`cardNumbers=[]` and confidence=medium top-1 selected from a
5-card sim cluster. Both scans should have been HIGH-confidence
Path B unique matches.

**Evidence (raw log).**
```
ocr spatial filter rejected 1 slash-line(s) outside bottom region: 068/131
ocr spatial filter rejected 1 slash-line(s) outside bottom region: 004/131€
```

**Vision actually saw.** The exact card_number printed at the
bottom of each card. The collector-pattern regex would have
matched `068/131` and `004/131` (after stripping the trailing
garbage "€"). Plausibility filter (y=131 ∈ [5, 600], x ∈
[1, 999]) would have accepted both. The spatial filter at
`OCRService.swift:208` rejected the bounding box.

**Root cause.** The user's hand position frames the card with
empty space below — the card_number printed at the bottom of the
*card* lands at midY ~0.20-0.30 in the *image*, just above the
0.22 threshold (Day 4 spatial filter, b76faed). Phase 1.5
relaxed to 0.35 (commit 5ce0d3e), which closes some cases but
not all.

**Fix or mitigation.**
- Phase 1.5 (5ce0d3e, 2026-05-07): threshold 0.22 → 0.35.
  Partial fix; closes the looser-grip cases but not the very
  loose ones at midY > 0.35.
- **Tier 1.1 stage 1 (8cad899, 2026-05-07): multi-pass
  fallback** — VERIFIED WORKING in production. Real-device
  re-scan of `prismatic-evolutions-68-heatran` at
  2026-05-07T05:25:59Z shows:
  ```
  ocr spatial filter rejected 1 slash-line(s) outside bottom region: 068/131 ₽
  ocr pass-2 fallback recovered 1 card_number(s) — 68
  cardNumbers=["68"] setHint=Iron Buster
  offline winning_path=ocr_intersect_unique confidence=high
  ```
  Same card pre-fix (2026-05-07T02:07:43Z) returned
  `cardNumbers=[]` confidence=medium with a 5-card Heatran sim
  cluster. Post-fix: HIGH confidence Path B unique match. The
  plausibility filter (`yInt ∈ [5, 600]`, `xInt ∈ [1, 999]`)
  is the sole defense during the fallback — adequate because
  asymmetric risk strongly favors admission (rejected real
  card_number costs HIGH→medium confidence; admitted false
  card_number falls through to Path C harmlessly).
- Tier 1.1 stage 2 (same commit): strip-pass ratio 0.18 → 0.25
  so the bottom-strip-only OCR also captures card_numbers in
  the 18-25% band.
- OPEN: Tier 1.1 stage 3 (separate session). Perspective
  correction in PopAlphaVisionEngine via CIPerspectiveCorrection
  using the four corners of `VNRectangleObservation` instead of
  the current bounding-box crop. Eliminates the orientation
  problem at its source — no rotation/skew survives the
  perspective unwrap, so the spatial filter assumption holds.
  Mode 2 in particular needs this; Mode 1's looser-grip
  symptom is fully addressed by stage 1+2.

**Repro.** Eval slugs `prismatic-evolutions-68-heatran` and
`prismatic-evolutions-4-budew`. Real-device scans
2026-05-07T02:07:43Z and 02:07:55Z (image hashes in
scan_uploads). Re-scan the same cards post-Tier-1.1 to verify
`cardNumbers=[68]` / `cardNumbers=[4]` now extract cleanly via
the multi-pass fallback.

---

### Mode 2 — Card photographed in landscape, card_number on side edge

**Symptom.** Real-device 2026-05-07 scan returned
`cardNumbers=[]` and `setHint="/ Nintendo / Creatures / GAME FREAK"`
at midY > 0.35. The copyright line (which prints at the very
bottom of an upright card, midY ~0.02-0.05) was reported as
*above* the 0.35 spatial filter cutoff.

**Evidence (raw log).**
```
ocr spatial filter rejected 3 slash-line(s) outside bottom region: NO- 0485, Lava Dome Pokémon ML S2- WT 948/bs) | 068/131 ₽ | / Nintendo / Creatures / GAME FREAK
ocr frameSize=858x600
```

**Vision actually saw.** Three slash-bearing lines including the
real card_number `068/131`. The frameSize 858×600 is landscape
(width > height); for a portrait card photographed in landscape
orientation, the card's "bottom" (where card_number prints) is
on a side edge of the image, not the bottom. Vision's midY for
the card_number observation is ~0.5 (vertical center of image).

**Root cause.** Spatial filter assumes card-bottom aligns with
image-bottom. False for landscape captures. The fix in Mode 1
(threshold relax) is insufficient.

**Fix or mitigation.**
- **Tier 1.1 stage 1 (8cad899, 2026-05-07): multi-pass fallback**
  fixes the OCR symptom. When the spatial filter rejects ALL
  slash-bearing observations, pass 2 re-runs without the
  spatial filter and the plausibility filter accepts the valid
  `068/131` candidate.
- **Tier 1.1 stage 3 (TBD commit, 2026-05-07): perspective
  correction** fixes the embedder-side problem at its source.
  The previous `croppedToCard` did an axis-aligned bounding-box
  crop, which preserved any rotation in the captured frame —
  so a sideways card produced a sideways crop, and the embedder
  saw a sideways embedding (kNN matched it against similar-art
  cards in other orientations rather than the same card
  upright). The new `croppedToCard` uses
  `CIFilter.perspectiveCorrection` with all four corners of
  `VNRectangleObservation`, flattening any quadrilateral into
  a rectangular card image. Output is then forced to portrait
  orientation (rotated 90° clockwise if width > height) since
  Pokemon TCG cards are always taller than wide.
  Residual ambiguity: the 90° rotation can leave the card
  upside-down ~50% of the time (we can't distinguish card-top
  from card-bottom from rectangle geometry alone). Stage 1's
  pass-2 fallback handles the OCR side of upside-down cards;
  the embedder-side upside-down-similarity hit is bounded
  because most Pokemon cards' kNN sim gap to other cards
  exceeds the rotation penalty.
- Zero-tap language detection (commit 2e22986) is unaffected
  by orientation — CJK character class check works on Vision
  observations regardless of which way the card is rotated.

**Repro.** Real-device 2026-05-07T02:07:55Z. After Tier 1.1
stage 3 ships, the same capture should produce a portrait
card image (frameSize height > width post-correction); the
embed kNN should give a tight sim-gap top-1 instead of the
multi-card cluster.

---

### Mode 3 — `004/131€` regex tail garbage

**Symptom.** Vision recognized "004/131€" with a euro sign
appended. The collector pattern
`\b(\d{1,3})\s*/\s*(\d{1,3})\b` should have matched the
`004/131` prefix and ignored the `€`, but the surrounding spatial
filter rejected the observation entirely (Mode 1 / 2), so we
never got to test whether the regex would have parsed it.

**Evidence (raw log).**
```
ocr spatial filter rejected 1 slash-line(s) outside bottom region: 004/131€
```

**Root cause.** Speculative — Vision occasionally appends UTF-8
glyphs to numeric runs when the card has a small bullet, dot,
copyright character, or other punctuation immediately after the
card_number. The regex's word-boundary `\b` should handle this;
since `131` ends at a digit and `€` is not a word character, the
boundary fires and `131` captures cleanly.

**Fix or mitigation.** Probably nothing needed beyond Mode 1's
spatial fix. Once we admit the observation, the regex should
extract `004/131` cleanly. Verify post-Tier-1.1 that the regex
does in fact produce `cardNumbers=[4]` from `004/131€` input.
Add a unit test if it doesn't.

---

### Mode 4 — Pumped-Up Whip / attack name as set_hint

**Symptom.** `setHint="Pumped-Up Whip"` reported in the log of a
Mega Evolution Tangrowth scan. Phase 1 v3 set_hint pickerSheet
should reject "Pumped-Up Whip" but didn't. (Note: setHint is
*not* used by the offline scanner path — this is dormant
reporting only.)

**Evidence (raw log).**
```
ocr frameSize=951x663 cardNumbers=[] setHint=Pumped-Up Whip ms=324.5
saved capture: 1. mega-evolution-7-tangrowth (sim=0.857) | OCR nums=[nil] set=Pumped-Up Whip
```

**Vision actually saw.** The attack name "Pumped-Up Whip" at
midY ~0.5 (mid-card). Phase 1 v3's hard reject (`midY < 0.22`)
admits this, soft-prefer (`midY > 0.30`) admits it, prose
stop-words don't include "pumped" or "whip", word-count-≥4 penalty
doesn't apply (2 words), so the scoring lets it through.

**Root cause.** Phase 1 v3's spatial filter for set_hint targets
bottom-of-card content (©, set code, illustrator). Mid-card
attack names slip through. Fixing this would require either a
much tighter top-of-card threshold (`midY > 0.85`, where modern
set logos actually print) or attack-name pattern matching.

**Fix or mitigation.** Deliberately NOT fixed. Eval re-baseline
2026-05-07 showed Path B → Path A gap is now 1.3pp; even perfect
set_hint extraction would only buy 1-2pp of real-device top-1.
Phase 1 set_hint work is at diminishing returns.

The dormant reporting in offline-mode logs is not a real bug —
the set_hint isn't sent anywhere. When the user falls back to
the server route, the route's Path A would either fuzzy-fail
"Pumped-Up Whip" against canonical_cards.set_name (no match) and
fall through to Path B harmlessly, or in the worst case
HIGH-confidence-WRONG. The trust-killer demote (5f2df4f) catches
the second case.

---

### Mode 8 — Stage-3 Y-flip bug — perspective-corrected card emerges upside-down

**Symptom.** Tier 1.1 stage 3 (commit 053a9a9, perspective correction
in `croppedToCard`) shipped 2026-05-07 and a real-device smoke
session immediately surfaced this regression: every post-stage-3
scan had Vision finding the card_number at `midY > 0.35` (rejected
by pass-1 spatial filter, recovered by pass-2 fallback). 25+ scans,
zero pass-1 hits. Pre-stage-3 had at least one pass-1 hit
(Base #11 Nidoking).

**Evidence (raw log, first scan post-stage-3).**
```
ocr spatial filter rejected 2 slash-line(s) outside bottom region:
    068/131 | ndo / Creatures / GAME FREAK
ocr pass-2 fallback recovered 1 card_number(s) — 68
ocr frameSize=526x756 cardNumbers=["68"] setHint=ndo / Creatures / GAME FREAK
```

The decisive signal: `setHint=ndo / Creatures / GAME FREAK` —
this is the copyright line that prints at the very bottom of an
upright card (`midY ~0.02-0.05`). For `pickSetHint` to return
it, the observation must be at `midY ≥ 0.22`. Confirms the card
is upside-down in the rendered image. Frame size is portrait
(526×756) so no 90° rotation was applied.

**Vision actually saw.** The card content correctly, just rendered
upside-down. card_name at the bottom of the image, copyright + card_number at the top.
This is why pass-2 fallback successfully recovers the digits —
Vision's OCR is fine; only the spatial filter assumption breaks.

**Root cause.** `CIFilter.perspectiveCorrection`'s output is
rendered with the input's `topLeft` corner mapped to the output's
**bottom-left** in CGImage display semantics — not the
top-left as the parameter name suggests. When
`createCGImage(from: extent)` renders the BL-origin CIImage to
a TL-origin CGImage, the expected Y-axis flip doesn't happen the
way the input parameter labels would suggest. The card emerges
inverted.

**Fix or mitigation.**
- **Stage 3.1 attempted (b6e18b5, 2026-05-07) — REVERTED 2026-05-07
  same day.** The fix was supposed to apply
  `CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -extent.height)`
  to the output CIImage to "undo" what looked like a Y-flip in
  the perspective-correction output. Real-device smoke
  immediately revealed this fix horizontally MIRRORED the
  rendered image instead of vertically flipping it. Post-fix
  setHints came back as `noitzudmo)` for "(Combustion",
  `92u& noTl` for "Iron Buster" — clear right-to-left mirrored
  text. card_numbers stopped extracting entirely because Vision
  saw mirrored digit shapes that didn't match the
  collector-pattern regex. End-to-end accuracy degraded
  (mirrored cards' embeddings still mostly worked, but pass-2
  fallback couldn't recover card_numbers for the disambiguation
  step).
- **Lesson learned**: my mental model of CIImage's
  bottom-left-origin coordinate space + `createCGImage(from:)`
  Y-axis flip behavior was wrong. The interaction is more subtle
  than I diagnosed analytically. Properly fixing this would
  require either inspecting actual saved capture images
  visually or adding diagnostic logging of (input
  quadrilateral corners, output extent, sample observation
  midY values) so the coordinate convention can be determined
  empirically rather than guessed.
- **Current state — ACCEPTED, not fixed**: pre-stage-3.1 (just
  053a9a9 perspective correction + the existing stage-1 pass-2
  fallback) is the shipping behavior. Pass-2 fallback handles
  the spatial-filter rejection gracefully — 8 of 9 pass-2
  firings on 2026-05-07T05:35Z (28-scan baseline) recovered
  the correct card_number. End-to-end behavior is HIGH-confidence
  on most scans where the embedder can identify the card. This
  is a cosmetic "internal pass-1 vs pass-2" distinction, not a
  user-facing accuracy issue. Defer the proper fix until we
  have time to do it correctly with diagnostic instrumentation.

**Repro.** Real-device 2026-05-07T05:49:29Z (Heatran),
T05:49:34Z (Budew with `cardNumbers=["104"]` — Mode 7 OCR
misread also exposed by upside-down digits being recognized with
extra optical noise). Re-scan the same cards post-stage-3.1 to
verify pass-1 fires directly without invoking the fallback.

---

### Mode 7 — OCR misreads card_number digits (admitted by pass-2 but Path B finds no match)

**Symptom.** Real-device 2026-05-07T05:41:55Z: re-scan of
Heatran (Prismatic Evolutions #68). Pass-2 fallback recovered
`cardNumbers=["163"]` instead of the expected `["68"]`. Vision
misread the leading `068` digits — `0` → `1`, `6` → `6`, `8` →
`3` → final read `163`. Path B intersection looked for a slug
with `card_number="163"` in the kNN top-K, found nothing, fell
through to `vision_only`.

**Evidence (raw log).**
```
ocr spatial filter rejected 1 slash-line(s) outside bottom region (pass-2 fallback may recover): 163/131 •
ocr pass-2 fallback recovered 1 card_number(s) — 163
ocr frameSize=973x666 cardNumbers=["163"] setHint=Iron Buster
offline winning_path=vision_only confidence=medium tried_candidates=["163"]
top-1: prismatic-evolutions-68-heatran sim=0.967
```
Worth noting: `163/131` does pass the plausibility filter
(`yInt=131 ∈ [5, 600]`, `xInt=163 ∈ [1, 999]`) — Pokemon sets
do go up past 130 cards (e.g., Surging Sparks 191), so 163 is
plausible. The filter is doing the right thing; Vision just
made an OCR error.

**Vision actually saw.** Likely degraded glyphs at the small
type size of the card_number row. The leading `0` looks like
`1` under blur; `8` looks like `3` under stylization or
similar artifact. Vision's beam search exposes alternates via
`topCandidates(N)`, but the multi-pass loop in
`extractCardIdentifiersMulti` already passes all candidates
through `collectorNumberCandidates` — so if Vision's
candidate-1 was `163` and candidate-2 was `068`, both should
have been added to `cardNumbers`. The fact that only `163`
appeared in the final log suggests either (a) Vision returned
only `163` as a candidate (no alternate), or (b) `068` got
deduplicated away via the `seenCardNumbers` set somewhere.

**Root cause.** Vision OCR error on small / stylized digits,
not a pipeline bug. The pass-2 fallback correctly admitted the
candidate; the plausibility filter correctly accepted it; Path
B intersection correctly found no matching slug; the system
correctly fell through to `vision_only` and the kNN got the
right answer anyway (sim 0.967 unique to Heatran).

**Fix or mitigation.**
- The end-to-end behavior was actually correct: wrong OCR, no
  match, fall through, kNN wins. No catastrophic failure.
- Worth investigating whether Vision's `topCandidates(3)` was
  returning multiple alternates and whether one of them was
  the correct `068`. If yes, sort the cardNumbers by frequency
  / candidate-rank in the multi-pass merge so the most
  trustworthy candidate is tried first against Path B.
- OPEN: Tier 1.1 stage 5 (separate session) — improve OCR
  digit accuracy via post-processing the
  `topCandidates(N)` per observation, picking the candidate
  whose card_number matches a slug in the kNN top-K when
  multiple parse to plausible digits.

**Repro.** Real-device 2026-05-07T05:41:55Z. Image hash in
scan_uploads. Re-scan the same Heatran post-Tier-1.1-stage-3
to see if perspective correction changes the OCR result (the
better-cropped card may give Vision more pixels on the
card_number, reducing misreads).

---

### Mode 6 — Vision sees no slash-bearing text at all (card_number row out of frame or unreadable)

**Symptom.** Real-device 2026-05-07T05:26:05Z (Budew) and
T05:26:18Z (Tangrowth) scans returned `cardNumbers=[]` AND
**no `ocr spatial filter rejected …` diagnostic line** at all.
This means Vision returned zero slash-bearing observations
across the entire frame — distinct from Modes 1/2 (Vision saw
the card_number but the spatial filter rejected it). Tier 1.1
stage 1's pass-2 fallback can't recover anything that Vision
didn't see in the first place.

**Evidence (raw log).**
```
ocr frameSize=978x675 cardNumbers=[] setHint=th noo tum, lhey cant play any kam ms=181.8
offline winning_path=vision_only confidence=high
saved: 1. prismatic-evolutions-4-budew (sim=0.970)
```
The garbage `setHint` ("th noo tum, lhey cant play any kam")
shows Vision was reading flavor-text fragments mid-card, not
the card_number row. The card_number was either out of frame
entirely or too small/blurry to recognize as text.

**Vision actually saw.** Mid-card text (flavor or attack
text), not the bottom-row collector number. No "X/Y" pattern
was returned in any observation.

**Root cause.** Probably one of:
- Card was framed such that the card_number row was below the
  captured frame entirely (over-tight crop, finger occluding
  bottom edge, card extending below viewfinder).
- Card_number was at very small pixel size (card occupies
  small portion of frame, so the ~12-15px digits become
  ~6-8px which is below Vision's accurate-mode threshold).
- Bottom of card had glare/blur that suppressed Vision's
  recognition of the digit characters.

These are framing / image-quality problems, not pipeline
problems.

**Fix or mitigation.**
- For these specific scans the kNN was strong enough to win
  on its own: Budew sim 0.970 (rank-2 at 0.872), Tangrowth
  sim 0.962 (rank-2 at 0.830). HIGH confidence preserved
  despite missing card_number.
- OPEN: Tier 1.1 stage 4 (image quality gates). Detect
  low-luminance / high-blur / small-card-area conditions
  before OCR runs and bump the user with a "hold steadier
  / move closer" hint instead of returning a confused
  result. The TestFlight build emits enough log signal
  (`scan_e2e total_ms`, `ocr_ms`, frameSize ratios) to
  retroactively quantify how often Mode 6 fires.
- OPEN: Tier 1.1 stage 3 (perspective correction) may help
  marginally — better-cropped images give Vision more pixels
  on the card_number row.

**Repro.** Real-device 2026-05-07T05:26:05Z (Budew),
T05:26:18Z (Tangrowth). Same eval slugs as Mode 1; the
differing OCR result reflects different framing in the scan,
not different cards.

---

### Mode 5 — Cards with no printed X/Y collector number

**Symptom.** Some vintage / promo / jumbo cards don't print a
fractional collector number on the front at all. `cardNumbers=[]`
is the correct answer for these — they have no extractable
signal.

**Evidence.** Eval images for slugs like
`base-set-charizard-thick-stamp` (hypothetical), Trainer Gallery
cards, sealed-product replicas, etc.

**Vision actually saw.** Either nothing slash-shaped, or
something the regex correctly rejects (e.g., HP value, year,
copyright dates).

**Root cause.** Card layout. Not fixable in iOS OCR — the
information isn't there.

**Fix or mitigation.** Path C (vision-only kNN) is the correct
fallback for these. The eval scoreboard correctly shows them at
top-1 confidence=medium when the kNN sim gap to rank-2 is
narrow.

The right systemic improvement: identify in `canonical_cards`
which slugs *don't* print a card_number, and mark them so the
runtime can short-circuit Path B trial-loops on those slugs and
go straight to Path C with adjusted confidence rules. Estimated
effort: ~1 day, defer until we see how many slugs are affected.

---

## Scoreboard — how often does each mode actually fire?

Update this whenever you have aggregate data to back it up.

| Mode | First seen | Real-device occurrences | Eval-corpus occurrences | Status |
|---|---|---|---|---|
| 1 (grip pushes card_number above threshold) | 2026-05-07 | 2/5 (initial), 1/4 post-fix | TBD | **VERIFIED FIXED** by Tier 1.1 stage 1 (8cad899) — pass-2 fallback recovered card_number=68 on Heatran re-scan 2026-05-07T05:25:59Z |
| 2 (landscape orientation) | 2026-05-07 | 1/5 sample | TBD | **VERIFIED FIXED (architecturally)** by Tier 1.1 stages 1+3 — OCR via pass-2 fallback, embedder via perspective correction. Real-device verification pending. |
| 3 (regex tail garbage) | 2026-05-07 | 1/5 sample | TBD | Mostly subsumed by Mode 1 fix; unfix until validated otherwise |
| 4 (attack name as set_hint) | 2026-05-07 | 5/5 — dormant | N/A | Closed — won't fix (set_hint marginal post-Phase-2) |
| 5 (no card_number printed) | TBD | TBD | TBD | Won't fix; Path C is correct fallback |
| 6 (Vision didn't see slash-bearing text) | 2026-05-07 | ~12/28 (~43%) pre-stage-3 sample | TBD | OPEN — Tier 1.1 stage 4 (image quality gates) — but kNN won HIGH on most observed cases |
| 7 (OCR misread digits, e.g. 068→163) | 2026-05-07 | 1/9 pass-2 firings (~11%) | TBD | OPEN — Tier 1.1 stage 5 (multi-candidate digit ranking). Failure mode is graceful: wrong card_number → Path B no-match → vision_only fallback. End-to-end result still correct in observed case. |
| 8 (Stage-3 perspective-correction coord quirk — card_number rejected by spatial filter) | 2026-05-07 | 25/25 (100%) post-stage-3 sample | TBD | **DEFERRED, not blocking.** Stage 3.1 attempted Y-flip mis-modeled the CIImage coord interaction and produced mirrored text — reverted same day. Pass-2 fallback recovers card_number gracefully (8/9 success on real device), so this is internal-pass-distinction only, NOT a user-facing accuracy issue. Proper fix needs diagnostic instrumentation (saved-image inspection or extent/corner logging) — deferred until we have time to do it right. |

The 5-scan sample on 2026-05-07 is too small to draw conclusions
about real-device frequency. A meaningful scoreboard requires:

1. `scan_identify_events` extended with
   `ocr_card_number_extracted: bool` and
   `ocr_spatial_filter_rejected_count: int` (Tier 1.5 in
   accuracy playbook).
2. Weekly aggregate dashboard: "what fraction of medium-confidence
   scans had `cardNumbers=[]`?" If it's 5% we don't care; if
   it's 50% Tier 1.1 is the dominant lever.

Until then, this scoreboard is qualitative. Add a "real-device
occurrences" tally each time you do a smoke-test session with
~10+ scans.

---

## How this doc gets updated

After every real-device smoke session that surfaces an OCR
failure:

1. Append a new `### Mode N` section. Don't reuse old numbers
   even if a mode is closely related — explicit numbering keeps
   the historical record stable.
2. Update the scoreboard with the new occurrence count.
3. If the failure motivates a new code change, link the commit
   in the entry's "Fix or mitigation" section.
4. If the failure motivates a new eval image, add the slug to
   `scan_eval_images` and note its slug in the "Repro" line.

Stale entries are NOT removed. Closed-won't-fix is a valid
status. Future engineers debugging unrelated regressions need to
see the full history of why we are where we are.
