# Scanner zero-tap sprint plan

**Active sprint. Started 2026-04-29.** Target: **85-92% top-1 with 95%+ HIGH-confidence
precision** by end of week, shipped to TestFlight. This doc is the
single source of truth — if context compacts, read this top-to-bottom
and you'll know exactly where we are.

---

## Where we are right now

### Latest production state (commit `c0c02dd`)

End-to-end on-device OCR is wired:
- iOS captures card → `OCRService.extractCollectorNumber` (Apple Vision,
  ~100-300ms on-device) → extracts `\b(\d{1,3})/(\d{1,3})\b` from the
  captured frame
- iOS sends `?card_number=N` query param to `/api/scan/identify`
- Server runs CLIP kNN as before, then post-filters candidates by
  `canonical_cards.card_number` matching the OCR result
- `ScanMatchReranker` still runs client-side as defense-in-depth

Server route filter ships in `b76faed`; iOS integration in `c0c02dd`.

### Eval numbers (run ids in scan_eval_runs)

| Stage | Run id | Top-1 | HIGH count | HIGH precision |
|---|---|---|---|---|
| Pre-Track-A (HEIC bug) | `de2df2bb` | 31.8% | 61 | 98.4%* |
| Post-Step-A baseline | `2713ec8e` | 48.0% | 84 | 91.7% |
| **Perfect-OCR ceiling** (ground-truth card_number) | `84cc8fe9` | **57.4%** | **134** | **94.8%** |
| **Real-device** (10 scans, 2026-04-29 21:00-21:20 UTC) | n/a | **~40%** (4/10) | — | — |

The perfect-OCR ceiling is the upper bound for the iOS-Vision path
because real-world OCR misses the number on some cards. Real-device
test fell well below that ceiling — which surfaced three problems
that block the rest of the sprint.

---

## The three problems blocking the sprint

### Problem 1 — HIGH-confidence-but-WRONG bug ⚠️ URGENT

**The trust killer.** Real-device test scan #11 (Umbreon V #94 → returned
HS Unleashed Suicune & Entei LEGEND #94 at HIGH confidence, 0.812 sim,
gap=null).

Mechanism: the OCR `card_number` filter narrowed to ONE survivor (Suicune
& Entei #94, the only `card_number=94` card in the kNN's top-K). With
exactly one candidate, `gap_to_rank_2 = null`. The route's confidence
logic is:

```ts
// app/api/scan/identify/route.ts:202-216
if (topDistance <= CONFIDENCE_HIGH_COS_DIST) {
  if (gap === null || gap >= CONFIDENCE_HIGH_MIN_GAP) return "high";
  return "medium";
}
```

The `gap === null` short-circuit was correct for pre-OCR: kNN failing
to return rank-2 meant strong confidence. After OCR filtering, **null
gap means "the filter dropped everything else"** — *not* uncontested
strength.

**Fix:** when `cardNumberFilterApplied = true`, treat null gap as a
downgrade. Require explicit CLIP+OCR agreement (the OCR-filtered top-1
also being the original CLIP top-1) before returning HIGH. Estimated
**~30 minutes** including re-deploy.

Files to touch:
- `app/api/scan/identify/route.ts` — `classifyConfidence()` plus thread
  the `cardNumberFilterApplied` flag in. The flag already exists
  (added in `b76faed`); just needs to be passed to the classifier.

### Problem 2 — Real-world OCR fails more than the ceiling assumed

The 57.4% ceiling assumed perfect OCR. Reality:
- **Black Kyurem ex #218** → predicted card had `card_number=86`. OCR
  returned wrong number or none → fell back to vision-only → wrong.
- **Centiskorch #030** → predicted Blaziken #42. Leading-zero "030"
  likely tripped the regex which expects `\d{1,3}` followed by `/`.
  Vision read "30/197" or just "30" — but if it read "030" the
  normalization should have stripped the zero. Need to verify.
- **Charizard V Black Star Promo SWSH062** → no slash-fraction on
  promo cards (just "SWSH062" near the set logo). Current regex
  doesn't match this pattern.
- **Lugia ex Prismatic** (corner-finger) → number is in the bottom
  corner; the operator's finger occludes it. Vision can't read what's
  not visible.

The current regex is `\b(\d{1,3})\s*/\s*(\d{1,3})\b` — only matches
"23/159" style. We need:
1. Also match standalone numbers near the bottom of the card
2. Also match alphanumeric set codes like "SWSH062", "JTG", "PRE",
   "SVI" — these are equally discriminating
3. When the corner is occluded, look at OTHER printed text — set
   name from the bottom strip, card name from the top — as fallback
   filters

Estimated **~3-4 hours** Day 1 work, plus iteration based on debug
view (Problem 3).

### Problem 3 — Vision rectangle detector misses some cards

Real-device scans #8 (Flareon ex 14) and #12 (Umbreon ex 60) didn't
even fire `/api/scan/identify` — the iOS auto-capture stability gate
never triggered. No `scan_identify_events` rows for them.

This is upstream of OCR / kNN — it's the iOS Vision rectangle detector
in the live preview. Possible causes (need debug view to confirm):
- Low contrast against the operator's hand/desk
- Glare obscuring the card border
- Tight framing
- Aspect ratio outside the detector's expected range

Hard to fix without seeing debug logs or video of the failed captures.
The OCR debug view (Problem 2 fix) should also surface "rectangle
not detected" feedback so we can correlate.

---

## The plan, day-by-day

### Day 1 — 2026-04-29 (today)

**Goal:** ship the HIGH-confidence bug fix and an OCR debug view; gather
real-device data on what Vision is actually reading.

**My work (~5-7 hours):**

| # | Task | Hours | File(s) |
|---|---|---|---|
| 1.1 | Fix HIGH-conf null-gap bug — when `cardNumberFilterApplied=true` and gap=null, downgrade to MEDIUM unless OCR-filtered top-1 was already the original kNN top-1 | 0.5 | `app/api/scan/identify/route.ts` `classifyConfidence` |
| 1.2 | Expand `OCRService.extractCollectorNumber` to also match: standalone `\d{1,3}` near bottom of frame, set codes like `SWSH062`, `JTG-\d+` | 2 | `ios/PopAlphaApp/OCRService.swift` |
| 1.3 | Server: accept `?set_code=` query param (not yet `?set_name=`); add to filter alongside `card_number` | 1 | `app/api/scan/identify/route.ts` |
| 1.4 | iOS: extract set_code via Vision, pass to server alongside card_number | 1 | `ios/PopAlphaApp/OCRService.swift`, `ScanService.swift` |
| 1.5 | OCR debug view in iOS scanner — when scan returns medium/low, show overlay listing the Vision-recognized text the OCR pass extracted (card_number / set_code / raw lines) | 1.5 | `ios/PopAlphaApp/ScannerTabView.swift` |
| 1.6 | Re-deploy, re-eval (perfect-OCR + simulated baseline) | 0.5 | n/a |

**Your work (~1 hour, after I deploy):**
- Re-scan the 6 live failures + 3 eval failures from today's test
- Tell me what Vision OCR shows in the debug overlay for each
- This data drives Day 2's two-stage architecture choices

**End of Day 1 target:**
- HIGH-confidence-wrong rate < 2%
- Real-world top-1 climbs from 40% → 50-55%
- Clear data on which OCR patterns fail

### Day 2 — Wednesday

**Goal:** ship two-stage OCR-first retrieval. When OCR confidently
extracts both card_number AND set_code/set_name, skip CLIP entirely
and do a direct `canonical_cards` lookup.

**My work (~6-8 hours):**

| # | Task | Hours |
|---|---|---|
| 2.1 | Server-side OCR-first branch in identify route: `WHERE set_code = ? AND card_number = ?` direct lookup. If 1-2 rows match, return as HIGH confidence with `winning_path = "ocr_direct"`. If 0 or 3+, fall through to current CLIP+filter pipeline. | 3-4 |
| 2.2 | Add `winning_path` column to `scan_identify_events` (migration) so production telemetry shows OCR-direct vs CLIP fallback share | 0.5 |
| 2.3 | Tighten OCR confidence logic — only take the OCR-direct path when both card_number AND set_code are extracted (not just one) | 1 |
| 2.4 | Re-eval with `--perfect-ocr` flag (which now passes set_code too) and without (real Vision behavior on eval images) | 1 |
| 2.5 | Iterate based on Day 1 debug-view data — fix the specific OCR failure modes the operator hit | 1-2 |

**End of Day 2 target:**
- Top-1: 75-85%
- HIGH count: 200+ of 277 (vs 134 ceiling, 84 baseline)
- HIGH precision: 95%+ (≤7 wrongs at most)
- This is the inflection point. If we don't hit ~75% by EOD Wed, escalate.

### Day 3 — Thursday

**Goal:** real-device validation, edge-case fixes, ready for TestFlight.

**Your work (~2-3 hours):**
- Build and scan 30+ real cards across modern + legacy sets, condition
  variants (clean / hand-held / corner-finger). Log results in a shared
  doc or via the in-app "wrong card?" flow which already promotes to
  scan_eval_images.

**My work (~3-4 hours):**
- Triage the failures from your scans (probably ≥5 different patterns)
- Fix high-frequency real-world issues: cards in sleeves, JP printings,
  full-art cards with non-standard number positions
- Add server-side card_number normalization for legacy formats
  (TG-numbers, SWSH-numbers, etc.)

**End of Day 3 target:** stable 80-88% on real-device scans, regression
tests pass, ready to TestFlight Friday.

### Day 4 — Friday

**Branch on Day 3 number:**

#### If at 85%+ — ship path
- iOS UX polish: tighten high-conf auto-navigate animation, add
  "wrong card?" quick-correct affordance (~3 hours)
- Server: telemetry dashboard so we can see post-deploy accuracy in
  real time (~2 hours)
- TestFlight build, push to test users

#### If at 78-84% — SigLIP backbone swap
- Re-embed the catalog (~24k cards) with SigLIP-ViT-L-16 locally on
  the Mac (unattended, ~1-2 hours wall)
- Bump `IMAGE_EMBEDDER_MODEL_VERSION`, dual-version support during
  cutover, A/B compare on eval (~3 hours)
- Re-eval; expect +5-10pp on cards CLIP-OAI-L/14 currently fails to
  recall

### Day 5 — Saturday/buffer

- TestFlight build (if not done Day 4)
- Final regression eval
- Document what shipped in `docs/scanner-runbook.md` (NEW; this sprint
  doc gets archived to `docs/archive/`)

---

## Open questions awaiting your decision (last asked: end of Day 0)

1. **Ship the HIGH-confidence-bug fix INDEPENDENTLY before continuing?**
   - Pro: it's a 30-min change, fixes a trust-killer in production NOW
   - Con: next round of scans you do should test the fix; small extra context-switch
   - **My recommendation: yes, ship now**

2. **OCR debug view scope:**
   - Option A — temporary, dev-only flag (`UserDefaults.standard.bool("ocrDebug")`)
   - Option B — long-term "show me what we read" affordance for end users
   - **My recommendation: A. Production users don't need to see Vision's raw extraction; we just need it for sprint debugging. Strip after sprint.**

---

## Key files / system state to know about

| File | Purpose | Current state |
|---|---|---|
| `app/api/scan/identify/route.ts` | Server scanner endpoint with CLIP + kNN + OCR filter | `b76faed` |
| `lib/ai/image-crops.ts` | resizeForUpload (HEIC→JPEG) + art crop generation | post-Step-A |
| `lib/ai/image-augmentations.ts` | Catalog augmentations (recipe v1 ONLY; v2 thumb-overlay retired) | post-Step-A |
| `ios/PopAlphaApp/OCRService.swift` | On-device Vision OCR for card_number | `c0c02dd` |
| `ios/PopAlphaApp/ScanService.swift` | iOS API client for /api/scan/identify | `c0c02dd` |
| `ios/PopAlphaApp/ScannerTabView.swift` | Scanner UI + capture orchestration | `c0c02dd` |
| `scripts/run-scanner-eval.mjs` | Eval harness, supports `--perfect-ocr` | `b76faed` |
| `docs/scanner-augmentation-playbook.md` | Old Stage A-C notes (augmentation history) | stable |
| `docs/scanner-finetune-runbook.md` | Stage D fine-tune (data-bound conclusion) | stable |
| `docs/scanner-zero-tap-sprint.md` | **THIS DOC** — active sprint plan | live |

### Useful queries while debugging

Recent iOS scans to debug a real-world issue:
```sql
SELECT created_at, confidence, top_match_slug, ROUND(top_similarity::numeric, 3) AS sim,
       ROUND(top_gap_to_rank_2::numeric, 3) AS gap, rank_2_slug, error
FROM scan_identify_events
WHERE client_platform = 'ios'
ORDER BY created_at DESC LIMIT 25;
```

HIGH-confidence precision over the past hour:
```sql
SELECT COUNT(*) FILTER (WHERE confidence = 'high') AS n_high,
       AVG(top_similarity) FILTER (WHERE confidence = 'high') AS avg_sim
FROM scan_identify_events
WHERE created_at > now() - interval '1 hour';
```

Once a card_number filter telemetry column exists (Day 2.2), add to
queries to see OCR-direct path share.

---

## Why this sprint matters

Top-1 = 48% with current code is below shippable. We've already
exhausted catalog-side levers (Step A retired thumb-overlay augs,
backbone is OAI ViT-L/14). Fine-tuning at 277 anchors is data-bound
(Stage D mining proved this). The remaining play is **structural**:
- OCR signal that CLIP literally can't see (printed numbers, set codes)
- Two-stage retrieval that uses OCR to bypass kNN where possible
- Optional backbone swap if OCR-only doesn't reach the bar

Nothing in this plan requires more labeled photos. Every lever is
either code or a one-time catalog re-embed. That's what makes a
one-week timeline realistic.

If the plan blows up — pull this doc back up, look at which day's
target was missed, see the open questions section. Don't restart
from scratch.
