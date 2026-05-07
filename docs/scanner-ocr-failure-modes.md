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
- **Tier 1.1 stage 1 (TBD commit, 2026-05-07): multi-pass
  fallback.** When the strict-region pass returns
  `cardNumbers=[]`, re-process the same Vision observations with
  `restrictToBottomRegion=false`. The plausibility filter
  (`yInt ∈ [5, 600]`, `xInt ∈ [1, 999]`) is the only defense
  against the original Chansey case during the fallback —
  asymmetric risk strongly favors admission (rejected
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
- **Tier 1.1 stage 1 (TBD commit, 2026-05-07): multi-pass
  fallback** is the partial fix here too. When the spatial
  filter rejects ALL slash-bearing observations (because the
  card is sideways and the card_number observation has midY
  > 0.35), pass 2 re-runs without the spatial filter and the
  plausibility filter accepts the valid `068/131` candidate.
  This recovers the card_number but the card-image embedding
  itself is still being computed against a sideways card — the
  kNN may still confuse it with similar-art cards in other
  orientations. Stage 1 fixes the OCR symptom.
- Workaround that exists now: when scanLanguage detection runs
  (zero-tap detection from CJK chars, commit 2e22986), the
  detected language flips to .en correctly even when the card
  is sideways — the language detector doesn't depend on
  orientation. Only card_number does.
- OPEN: Tier 1.1 stage 3 (separate session). The full fix is
  perspective correction so the OCR'd image is ALWAYS
  axis-aligned with card-bottom at image-bottom, regardless of
  how the user held the phone. CIPerspectiveCorrection with the
  rectangle's 4 corners + portrait-orientation enforcement
  (rotate 90° if the corrected image is wider than tall, since
  Pokemon cards are always portrait). This also fixes the
  embed-side similarity problem because the embedder gets a
  properly oriented card.

**Repro.** Real-device 2026-05-07T02:07:55Z. The diagnostic line
above is the literal log text. After Tier 1.1 stage 1 ships,
the same scan should log a `pass-2 fallback recovered N
card_number(s)` line and produce non-empty `cardNumbers`.

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
| 1 (grip pushes card_number above threshold) | 2026-05-07 | 2 of 5 (40%) sample | TBD | OPEN — Tier 1.1.a |
| 2 (landscape orientation) | 2026-05-07 | 1 of 5 (20%) sample | TBD | OPEN — Tier 1.1.a same fix |
| 3 (regex tail garbage) | 2026-05-07 | 1 of 5 sample | TBD | Speculative; unfix until validated |
| 4 (attack name as set_hint) | 2026-05-07 | 5 of 5 (100%) — dormant | N/A (eval injects setHint) | Closed — won't fix |
| 5 (no card_number printed) | TBD | TBD | TBD | Won't fix; Path C is correct fallback |

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
