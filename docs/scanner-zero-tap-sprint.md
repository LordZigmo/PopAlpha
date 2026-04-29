# Scanner zero-tap sprint plan

**Active sprint. Started 2026-04-29.** Target: **85-92% top-1 with 95%+ HIGH-confidence
precision** by end of week, shipped to TestFlight. This doc is the
single source of truth — if context compacts, read this top-to-bottom
and you'll know exactly where we are.

---

## Where we are right now

### Latest production state (commit `1c44dc6`)

End-to-end on-device OCR is wired with both filters AND a debug overlay:
- iOS captures card → `OCRService.extractCardIdentifiers` (Apple Vision,
  ~100-300ms on-device) → extracts BOTH `card_number` (e.g. `70` from
  `70/197`) AND `set_hint` (longest non-numeric line via `pickSetHint`)
- iOS sends `?card_number=N&set_hint=...` to `/api/scan/identify`
- Server runs CLIP kNN, then layers two post-filters:
  - `card_number` match against `canonical_cards.card_number` (with
    leading-zero normalization)
  - `set_hint` fuzzy contain-match against `canonical_cards.set_name`
- `classifyConfidence` was hardened against the trust-killer "OCR
  filter narrowed to 1 wrong card → HIGH confidence" bug: when a filter
  changed CLIP's original top-1 AND gap is null, downgrade HIGH→MEDIUM
- Debug overlay (#if DEBUG) in `ScanPickerSheet` shows what Vision
  actually extracted on each medium-confidence scan — strips out of
  release builds

Commits: `b76faed` (server card_number filter), `c0c02dd` (iOS
card_number wiring), `5f2df4f` (HIGH-conf trust-killer fix),
`8f11595` (set_hint pipeline + iOS combined extractor),
`1c44dc6` (debug overlay).

### Eval numbers (run ids in scan_eval_runs)

| Stage | Run id | Top-1 | HIGH | HIGH precision |
|---|---|---|---|---|
| Pre-Track-A (HEIC bug) | `de2df2bb` | 31.8% | 61 | 98.4%* |
| Post-Step-A baseline | `2713ec8e` | 48.0% | 84 | 91.7% |
| Perfect-OCR (card_number only) | `84cc8fe9` | **57.4%** | **134** | **94.8%** |
| Perfect-OCR + set_hint | (fail-to-persist) | **57.4%** | **123** | TBD |
| Real-device (10 scans, 2026-04-29 21:00 UTC, pre-trust-killer-fix) | n/a | ~40% (4/10) | — | — |

**Day 1.6 result is decisive: filtering AFTER kNN has hit its
ceiling at 57.4%.** Set_hint added zero top-1 because the 277-image
eval doesn't have many cross-set collisions. The HIGH count drop
(134→123) is the trust-killer fix demoting OCR-narrowed-to-1 cases
that changed CLIP's top-1 — exactly what we wanted, fewer false-HIGHs.

The 42.6% remaining wrongs are **kNN-recall failures**: CLIP doesn't
return the right card in its top-K, and post-filtering can't fix what
kNN never returned. **Day 2 must bypass kNN** for the OCR-rich cases
to unlock the next leg of accuracy.

---

## Problems surfaced and their fix status

### Problem 1 — HIGH-confidence-but-WRONG bug ✅ FIXED in `5f2df4f`

**The trust killer.** Real-device test scan (Umbreon V #94 → returned
HS Unleashed Suicune & Entei LEGEND #94 at HIGH confidence, 0.812 sim,
gap=null).

Mechanism: OCR `card_number` filter narrowed to ONE survivor (Suicune
& Entei, the only `card_number=94` card in the kNN's top-K). With
exactly one candidate, `gap_to_rank_2 = null`. The route's confidence
logic was:

```ts
if (gap === null || gap >= CONFIDENCE_HIGH_MIN_GAP) return "high";
```

The `gap === null` short-circuit was correct for pre-OCR but became a
trust-killer after OCR filtering: null gap meant "we removed rank-2,"
not "rank-2 is far behind."

Fix shipped in `5f2df4f`: track `clipOriginalTopSlug` (kNN's top-1
BEFORE the filter), pass `ocrChangedTop1 = (any-ocr-filter-applied
&& matches[0] !== clipOriginalTopSlug)` to `classifyConfidence`, and
when both `ocrChangedTop1` and gap=null hold, downgrade HIGH→MEDIUM.
The common case (CLIP and OCR agree) still earns HIGH.

### Problem 2 — Real-world OCR fails more than ceiling assumed (PARTIALLY FIXED)

The 57.4% ceiling assumed perfect OCR. Real device:
- **Black Kyurem ex #218** → wrong card returned. OCR may have
  failed or the route fell back to CLIP-only.
- **Centiskorch #030** → Blaziken #42. Leading-zero handling needs
  verification.
- **Charizard V Black Star Promo SWSH062** → no slash-fraction on
  promo cards. Need alphanumeric set-code support.
- **Lugia ex Prismatic** (corner-finger) → number occluded by finger.

Day 1.2-1.4 work shipped in `8f11595`:
- iOS `OCRService.extractCardIdentifiers` returns BOTH `cardNumber`
  AND `setHint` from one Vision pass
- Server route accepts `?set_hint=` and applies fuzzy
  case/punctuation-insensitive contain-match against
  `canonical_cards.set_name`
- Both filters layered (card_number first, set_hint second), each
  fail-graceful — empty result falls back to prior step

What this commit DIDN'T fix:
- Alphanumeric set codes like "SWSH062" still aren't matched by the
  collector-number regex
- Standalone numbers (without `/`) aren't extracted
- These will be addressed in Day 2 work

### Problem 3 — Vision rectangle detector misses some cards (UNRESOLVED)

Real-device scans (Flareon ex 14, Umbreon ex 60) didn't fire
`/api/scan/identify` at all — the iOS auto-capture stability gate
never triggered. Upstream of OCR / kNN. Day 3 real-device validation
will hopefully surface what makes Vision skip those frames; deferred
until then.

### Problem 4 — `image_hash` drift from HEIC conversion (NEW, BLOCKING TELEMETRY)

When Step A converted the 120 HEIC objects in `scan_eval/<hash>.jpg`
to JPEG, we kept `scan_eval_images.image_hash` as the original HEIC
bytes hash but the storage object now contains JPEG bytes. The route
hashes incoming bytes — so `scan_identify_events.image_hash` is the
JPEG hash, which doesn't join to `scan_eval_images.image_hash`
anymore.

Symptom: post-eval HIGH-precision queries that join through
`image_hash` produce wrong numbers. The Day 1.6 result shown
72.4% HIGH precision is wrong — actual is closer to 95% but I
can't compute it cleanly until this is patched.

Fix (Day 1.6.5, ~5 min): re-hash every `scan_eval/<hash>.jpg`
storage object's CURRENT bytes, update `scan_eval_images.image_hash`
to the new value. Idempotent.

---

## The plan, day-by-day

### Day 1 — 2026-04-29 ✅ DONE

**Shipped:**

| # | Task | Commit | Notes |
|---|---|---|---|
| 1.1 | HIGH-conf null-gap bug fix | `5f2df4f` | Trust killer addressed |
| 1.2-1.4 | Combined OCR extractor + set_hint pipeline (server + iOS + eval harness) | `8f11595` | Both filters live |
| 1.5 | OCR debug overlay in `ScanPickerSheet` | `1c44dc6` | DEBUG-only; surfaces Vision extraction on medium-confidence picker |
| 1.6 | Perfect-OCR + set_hint re-eval | (failed to persist) | Top-1 stayed at 57.4% — set_hint added zero lift on this corpus; HIGH dropped 134→123 (trust-killer working) |

**End of Day 1 actual:**
- HIGH-confidence-wrong rate addressed structurally (the Umbreon-V→Suicune-Entei
  pattern can no longer return HIGH)
- Real-world top-1 not yet remeasured (Day 3 work, post-Day-2)
- Day 1.6 revealed: filtering after kNN has a hard ceiling at 57.4% on
  this eval. Day 2 must bypass kNN to break through.

### Day 1.6.5 — `image_hash` drift patch (~10 min, doing now)

The HEIC→JPEG conversion in Step A left `scan_eval_images.image_hash`
pointing at the original HEIC bytes hash. The route hashes incoming
JPEG bytes, so `scan_identify_events.image_hash` no longer joins to
`scan_eval_images.image_hash` for the ~120 converted entries.

Fix: a one-shot script that re-hashes every `scan_eval/<hash>.jpg`
storage object's CURRENT bytes and updates the `scan_eval_images` row
to match. Idempotent. Unblocks HIGH-precision telemetry queries.

### Day 2 — Wednesday: two-stage OCR-first retrieval (LAYERED)

**Goal:** bypass CLIP+kNN for cards where OCR has enough signal to
resolve directly via `canonical_cards`. Three paths inside the route
based on what OCR extracted, in priority order:

| Path | Condition | Logic | Confidence |
|---|---|---|---|
| **A — strict** | `card_number` AND `set_hint` both present | `SELECT * FROM canonical_cards WHERE card_number = ? AND set_name ILIKE '%hint%' LIMIT 5`. If exactly 1 → return HIGH. If 2-3 → run kNN over THOSE slugs to disambiguate, return MEDIUM. If 0 → fall through. | HIGH if unique, MEDIUM if ≤3 |
| **B — partial (THE MIDDLE LAYER)** | `card_number` only (set OCR failed or ambiguous) | `SELECT * FROM canonical_cards WHERE card_number = ?`. Combine with kNN: keep only intersection (slugs that are BOTH in canonical_cards@card_number AND in kNN top-K). If 1 → HIGH; if 2-3 → MEDIUM; if 0 → fall through. | HIGH/MEDIUM |
| **C — fallback** | OCR failed entirely (no number, no usable hint) | Current CLIP+kNN pipeline. | Current logic |

Path B (the middle layer) is the user's specific request — it
catches more cases than strict-only because Vision often pulls the
collector number reliably but flubs the set name (small text, glare).
By using card_number alone as a server-side allow-list AND
intersecting with kNN's visual signal, we get most of the lift of
Path A even when set OCR fails.

Implementation tasks:

| # | Task | Hours |
|---|---|---|
| 2.1 | Path A direct-lookup branch + result mapping (Path A-1 → HIGH, A-2/3 → MEDIUM via mini-kNN) | 3 |
| 2.2 | Path B intersection branch — pull all slugs with matching card_number (could be ~50 globally, fine for in-memory intersect with kNN top-K) | 2 |
| 2.3 | `winning_path` field added to scan_identify_events + response so iOS + telemetry know which path fired | 1 |
| 2.4 | Tighten OCR confidence — Path A unique → HIGH always, Path B unique-after-intersect → HIGH only if CLIP also liked it (gap signal), Path B 2-3 → MEDIUM | 1 |
| 2.5 | Re-eval with `--perfect-ocr` (which exercises Path A) and without (which exercises Path B + C) | 1 |

**End of Day 2 target:**
- Top-1: 75-85% (strict Path A on perfect OCR; partial Path B real-world)
- HIGH count: 200+ of 277
- HIGH precision: 95%+ (kept by the dual-signal requirement on Path B)
- Inflection point — if we don't hit ~75% EOD Wed, escalate.

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

## Resolved decisions (don't re-litigate)

1. ✅ **HIGH-confidence-bug fix shipped independently** (`5f2df4f`).
2. ✅ **OCR debug view = DEBUG-only flag (`#if DEBUG`).** Strip-clean
   step on sprint exit is just deleting the `#if DEBUG` block in
   `ScanPickerSheet`.
3. ✅ **Day 2 will use the LAYERED two-stage architecture** (Path A
   strict + Path B middle-layer + Path C fallback) per user direction.

## Open: nothing currently blocking

---

## Key files / system state to know about

| File | Purpose | Current state |
|---|---|---|
| `app/api/scan/identify/route.ts` | Server scanner endpoint with CLIP + kNN + OCR filter (card_number + set_hint) | `8f11595` + `5f2df4f` |
| `lib/ai/image-crops.ts` | resizeForUpload (HEIC→JPEG) + art crop generation | post-Step-A |
| `lib/ai/image-augmentations.ts` | Catalog augmentations (recipe v1 ONLY; v2 thumb-overlay retired) | post-Step-A |
| `ios/PopAlphaApp/OCRService.swift` | `extractCardIdentifiers` returns card_number + set_hint in one Vision pass | `8f11595` |
| `ios/PopAlphaApp/ScanService.swift` | Sends both filters to identify route | `8f11595` |
| `ios/PopAlphaApp/ScannerTabView.swift` | Scanner UI; runIdentify uses combined extractor; debug overlay | `1c44dc6` |
| `ios/PopAlphaApp/ScanPickerSheet.swift` | Medium-conf picker + DEBUG-only OCR debug strip | `1c44dc6` |
| `scripts/run-scanner-eval.mjs` | Eval harness, `--perfect-ocr` passes both card_number + set_name | `8f11595` |
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
