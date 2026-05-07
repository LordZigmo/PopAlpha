# Scanner multi-scan mode — design sketch

> **Status:** RFC, not yet implemented. This doc proposes a design;
> open questions are flagged at the bottom and need resolution
> before any code lands.

Companion to:
- `scanner-accuracy-playbook.md` — strategic accuracy framework
- `scanner-runbook.md` — operational scanner reference
- `scanner-zero-tap-sprint.md` — historical sprint diary

---

## The problem

The current scanner is a **single-scan modal flow**:

1. User opens scanner.
2. Scans card.
3. HIGH confidence → auto-navigate to `CardDetailView`.
4. User decides whether to add to portfolio.
5. User pops back to scanner.
6. Repeat.

Step 5 is the friction. Every card is a 3-tap round trip
(scan → detail → back → scan), with the scanner re-warming
between each cycle. For the "I have a stack of cards I want to
log" use case — opening a pack, processing a binder page,
photographing a friend's collection — this is 30 seconds per
card when it should be 2.

A **multi-scan mode** keeps the scanner armed continuously,
accumulates results in a tray, and offers a single bulk-add
action at the end. 30 cards become a 60-second job instead of a
15-minute job.

---

## User flow

```
┌─────────────────────────────────────┐
│  Scanner (single-mode, default)     │
│  [crown] [lang pill] [stack icon] ←─┼── tap to enter multi-mode
│                                     │
│       [viewfinder]                  │
│                                     │
└─────────────────────────────────────┘
                   ↓ tap stack icon
┌─────────────────────────────────────┐
│  Scanner (multi-mode)               │
│  [crown] [lang pill] [stack● 0]     │
│                                     │
│       [viewfinder]                  │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ 0 cards · tap to expand     │   │ ← tray (collapsed)
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
                   ↓ scan card 1
┌─────────────────────────────────────┐
│  Scanner (multi-mode, after scan)   │
│  Brief flash + haptic               │
│                                     │
│       [viewfinder]                  │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ [thumb] · 1 card · expand   │   │ ← chip appears, scanner re-arms
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
                   ↓ scan more cards
┌─────────────────────────────────────┐
│       [viewfinder]                  │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ [▢][▢][▢][▢][▢] · 5 · ▼    │   │ ← chips, last 5 visible, count badge
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
                   ↓ tap tray to expand
┌─────────────────────────────────────┐
│  Multi-scan tray  · 5 cards   [✕]  │ ← sheet/modal
│                                     │
│  ▢  Charizard ex                    │
│      Obsidian Flames #125  · HIGH   │
│      $42.50                  [—][1][+]│
│  ─────────────────────────────────  │
│  ▢  Pikachu                         │
│      151 #58  · MED  ⚠              │ ← MED indicator, tap to fix
│      $8.20                   [—][1][+]│
│  ─────────────────────────────────  │
│  ...                                │
│                                     │
│              Total: $87.40          │
│                                     │
│  [Clear all]    [Add 5 to portfolio]│
└─────────────────────────────────────┘
```

---

## State model

A new `MultiScanSession` actor holds the tray's state:

```swift
@MainActor
final class MultiScanSession: ObservableObject {
    @Published private(set) var entries: [MultiScanEntry] = []
    @Published var isActive: Bool = false

    func add(_ match: ScanMatch, confidence: String, image: UIImage?) { ... }
    func remove(at index: Int) { ... }
    func clear() { ... }
    func bulkAddToPortfolio() async throws -> BulkImportResult { ... }
}

struct MultiScanEntry: Identifiable, Equatable {
    let id: UUID
    let match: ScanMatch
    let confidence: String  // "high" | "medium" | "low"
    let scannedAt: Date
    let thumbnailImageHash: String?   // points at scan-uploads/<hash>.jpg
    var quantity: Int = 1
    // Variant + grade default to (canonical printing, RAW) for v1.
    // Edit-in-tray could add these in v2.
    var grade: String = "RAW"
    var printingId: String? = nil
}
```

`MultiScanSession` is a singleton (or owned by `ScannerHost`) so
the tray persists across tab switches within a single app
session. Cross-launch persistence is **deferred to v2** — see
"Edge cases" below.

`ScannerHost.scanMode: ScanMode` is the new mode flag:

```swift
enum ScanMode { case single, multi }
```

When `scanMode == .multi`, the existing `runIdentify` flow is
mostly unchanged — but the post-identify routing differs:

| Confidence | Single mode (today) | Multi mode (new) |
|---|---|---|
| HIGH | Auto-navigate to CardDetailView | Append top-1 to tray, re-arm |
| MEDIUM | Show picker sheet | **Append top-1 to tray with `confidence=medium` flag, re-arm**. User reviews via tray expand. |
| LOW | Silent re-arm | Silent re-arm (no tray entry) |

The MEDIUM behavior diverges deliberately. In single-mode, the
picker is the right UX because the user is going to look at the
result anyway. In multi-mode, the speed/throughput is the value
prop — auto-adding top-1 even at MEDIUM, with an in-tray
disambiguation flow, is the right tradeoff.

---

## UI changes

### New: `multiScanIcon` (top-right overlay)

Sibling to `crownButton` and `languagePill` in
`ScannerTabView.swift`. Two visual states:

- **Inactive** — outlined "stacked rectangles" SF Symbol
  (`square.stack`), tappable to enter multi-mode.
- **Active** — filled icon with the tray count badge overlaid
  (e.g., `square.stack.fill` + `.badge(N)`).

Tap to toggle mode. When activating, the tray slides up from the
bottom. When deactivating with a non-empty tray, prompt:
"Discard 5 scanned cards?" — yes clears, no stays in mode.

### New: `MultiScanTray` (bottom overlay)

Always visible when `scanMode == .multi`. Two visual states:

- **Collapsed** — single horizontal strip ~70px tall. Shows up
  to 5 most-recent thumbnail chips left-to-right, each ~50×70.
  A count badge ("· 12 cards · ▼") indicates total. Tappable
  to expand.
- **Expanded** — sheet that fills lower 60-70% of screen. List
  of all entries with image, name, set, card_number, confidence
  badge, price, qty stepper. Bottom action bar: "Clear all" +
  "Add N to portfolio" (primary).

The collapsed strip stays out of the camera framing area
(reserves bottom 70px). `firstFrameRendered`-driven animations
already exist; the tray uses similar transitions.

### New: `MultiScanReviewSheet`

The expanded list. Wires up:

- Per-row tap → opens a small `MatchDisambiguationSheet` showing
  top-3 candidates (re-fetched from the original `imageHash`).
  User can re-pick. This is what the MEDIUM-confidence picker
  does today, just deferred until tray review.
- Per-row swipe-to-delete.
- Per-row qty stepper (1-99).
- "Add N to portfolio" — calls bulk-import API.

---

## API surface

**Reuse `/api/holdings/bulk-import`** (`app/api/holdings/bulk-import/route.ts`).

Add a new `source` enum value to its `InsertPayload`:

```typescript
source: "csv_import" | "scan_batch"
```

Multi-scan submission shape:

```json
POST /api/holdings/bulk-import
{
  "rows": [
    {
      "canonical_slug": "obsidian-flames-125-charizard-ex",
      "printing_id": null,
      "grade": "RAW",
      "qty": 1,
      "source": "scan_batch"
    },
    ...
  ]
}
```

Existing per-row error handling already returns
`{ inserted, errors: [{row_index, error}, ...] }` — multi-scan
shows a per-row error indicator if any rows fail (network, RLS,
non-existent slug from a future client-state bug, etc.).

The route's `MAX_ROWS = 500` cap is more than enough — a typical
multi-scan session is 10-50 cards.

**Telemetry:** `source: "scan_batch"` shows up in
`holdings.source` and `portfolio.activity` so we can:
- Quantify multi-scan adoption
- Measure average tray size at submission
- Correlate "added via multi-scan" with "later removed" to
  surface false-positive rate

---

## Edge cases + decisions

### Same card scanned twice in one session
Default behavior: each scan is a separate entry. User can
manually adjust qty in the review sheet. v2 could auto-merge
into qty=N if `(canonical_slug, printing_id, grade)` match.

### Wrong card in tray (false positive on MEDIUM auto-add)
Per-row tap → disambiguation sheet → user re-picks. Or
swipe-to-delete. Either is one tap.

### User backgrounds the app mid-session
v1: tray clears on app background-foreground after 5 minutes
(reasonable since multi-scan is a "I'm doing this right now"
flow). Cross-launch persistence is v2.

### Network failure during bulk-add
The `bulk-import` endpoint is transactional per-row at the SQL
level (one Supabase call, reports per-row outcomes). If the
HTTP request itself fails, retry once with idempotency — the
client retains the tray contents until success. Show "Couldn't
add — retry?" with the partial results visible.

### Premium gating
Single-mode scans count against the free-tier scan quota
(`PremiumGate.shared.offlineScannerEnabled`). Multi-mode should
follow the same accounting — each individual scan adds to the
quota. **Deferred decision:** does multi-mode require Pro? My
suggestion is no for v1 (don't add another paywall for
something that should be a quality-of-life win), but
free-tier's existing per-day scan limit still applies.

### Confidence indicators in the tray
Color-coded confidence badge per chip / row:
- HIGH → green
- MEDIUM → yellow + ⚠ icon, prompts user to review
- LOW → never enters tray (silent re-arm)

### Scanner stays running while tray is expanded?
**No.** When the review sheet is up, pause the camera (free up
power, preserve sanity). When dismissed, resume.

### Bulk-add idempotency
If the user double-taps "Add to portfolio", the second tap
should be a no-op. Lock the action button during the in-flight
network call; on success, show confirmation + clear the tray;
on failure, re-enable the button.

---

## v1 scope vs deferred

**v1 — minimum shippable:**
- Mode toggle in scanner UI (`square.stack` icon)
- `MultiScanSession` state + tray UI (collapsed + expanded)
- HIGH/MEDIUM auto-add to tray
- Per-row swipe-to-delete + tap-to-disambiguate
- Default `(printing=canonical, grade=RAW, qty=1)` per entry
- Manual qty stepper in review sheet
- Bulk-add via `/api/holdings/bulk-import` with `source: "scan_batch"`
- Tray clears after successful add

**v2 — defer:**
- Cross-launch tray persistence (Realm or local SQLite)
- Same-card auto-merge (qty consolidation)
- Per-entry grade picker in review sheet
- Per-entry purchase price entry
- Multi-card-per-frame detection (separate playbook
  consideration, see `scanner-accuracy-playbook.md` §3.3)
- "Save tray as Quick List" (e.g., "Charizard collection") for
  named multi-scan sessions

**v3 — speculative:**
- "Smart suggestions" — if scanner sees a card already in your
  portfolio, suggest "Add another?" vs "Already owned"
- "Delta diff" — scan a binder, get a diff vs your current
  portfolio (added, missing, unchanged)

---

## Files that need to change (v1)

| File | Change |
|---|---|
| `ios/PopAlphaApp/MultiScanSession.swift` | NEW — the actor + entry struct |
| `ios/PopAlphaApp/MultiScanTrayView.swift` | NEW — collapsed strip + expanded sheet |
| `ios/PopAlphaApp/MultiScanReviewSheet.swift` | NEW — the per-row review UI |
| `ios/PopAlphaApp/ScannerTabView.swift` | Add mode toggle + post-identify routing branch |
| `ios/PopAlphaApp/HoldingsService.swift` | Add `bulkAddFromScans(_ entries: [MultiScanEntry])` method |
| `app/api/holdings/bulk-import/route.ts` | Allow `source: "scan_batch"` |
| `docs/scanner-runbook.md` | Append a "Multi-scan mode" section once shipped |

Estimated effort: **3-4 days**, depending on UI polish.

---

## Open questions

These need resolution before ship:

1. **Mode toggle: persistent or auto-exit?** When the user
   bulk-adds, should the app stay in multi-mode (ready for
   another batch) or auto-exit to single-mode? Suggest:
   stay in multi-mode, it matches the user's intent.

2. **Confidence thresholds: should LOW also auto-add?** Right
   now LOW is "silently re-arm" in single-mode. In multi-mode,
   should LOW enter the tray with a prominent ⚠? Suggest no —
   LOW is "Vision didn't see anything useful," tray-adding it
   would dilute the signal of HIGH/MED.

3. **Free-tier quota: does each multi-scan tap count as one
   scan?** Suggest yes — quota is a scan-rate signal. Multi-mode
   shouldn't bypass it.

4. **Picker UX for MEDIUM in multi-mode: auto-add top-1 OR show
   inline picker?** The doc above proposes auto-add top-1.
   Alternative: show an inline picker chip in the tray that
   lets the user pick without leaving the scanner. Slower per
   scan but more accurate.

5. **What's the right name?** "Multi-scan mode" is descriptive
   but blah. "Stack mode"? "Batch mode"? "Continuous scan"?
   This affects the UI copy and onboarding.

6. **Onboarding hint.** First time the user enters multi-mode,
   show a one-time tooltip explaining the tray? Or rely on
   discoverability of the tray itself?

7. **Should multi-scan have its own eval mode?** Today's eval
   harness assumes single-scan-with-result. Multi-scan
   accuracy is "did all N cards in the tray match the user's
   actual stack?" — a different metric. **My take:** defer.
   The single-scan eval already measures per-scan accuracy;
   multi-scan piggybacks on that.

---

## Recommendation

Ship v1 in a 3-4 day sprint after the Tier 1 OCR robustness
work lands (`scanner-accuracy-playbook.md` §3 Tier 1.1). Reason:
multi-scan amplifies the cost of OCR failures — a 5% per-scan
failure rate becomes a "1-2 wrong cards in every 30-card batch"
problem that the user has to clean up. Better OCR robustness
first means cleaner trays, less in-tray disambiguation, fewer
swipe-to-delete actions, higher user trust in the bulk-add.

Once Tier 1 lands and real-device top-1 climbs to ~88-92%,
multi-scan ships into a much better baseline.
