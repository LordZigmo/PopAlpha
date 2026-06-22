import Foundation
import Combine
import SwiftUI
import UIKit

// MARK: - MultiScanEntry
//
// One card scanned into the multi-scan tray. Holds the rendering data
// (name, set/number, thumbnail), the disambiguation surface (full
// candidate list — kept for a future re-pick flow), and the bulk-add
// payload (canonical_slug + grade=RAW + qty=1 by default). Price loads
// async after append so the row appears immediately and the dollar
// figure fills in within ~200ms.

struct MultiScanEntry: Identifiable, Equatable {
    let id: UUID
    var match: ScanMatch
    /// Full top-K from the identify call. Kept so a future per-row
    /// re-pick can swap to a different candidate without re-scanning.
    let candidates: [ScanMatch]
    /// "high" or "medium" — drives a colored ring on the chip and
    /// (eventually) a "Review" CTA on the expanded row. LOW never
    /// reaches the tray.
    let confidence: String
    let scannedAt: Date
    /// SHA256 of the scanned JPEG, when known. Threaded through so the
    /// user-correction flow can post bytes-by-hash without re-uploading.
    let imageHash: String?
    /// Scanner language at the time of this scan ("EN" / "JP"). Pinned
    /// per-row so a later correction attributes to the row's original
    /// language, not the scanner's CURRENT language. Codex P2 on PR
    /// #101: ScannerHost.scanLanguage updates on every scan (manual
    /// pill toggle, CJK auto-flip), so correcting an earlier EN row
    /// after a later JP scan would otherwise record the user_correction
    /// anchor under the wrong language.
    let scanLanguage: ScanLanguage
    var quantity: Int = 1
    var grade: String = "RAW"
    var printingId: String? = nil
    /// Finishes for this row's card, loaded async alongside price/image.
    /// The row's finish menu only appears when there's a real choice
    /// (count >= 2); nil printingId means "Default" (canonical printing).
    var availablePrintings: [CardPrintingOption] = []
    /// Loaded async via CardService.fetchCardMetrics. Nil = still
    /// loading or unknown. Drives the per-row price label and the
    /// running tray total.
    var marketPriceUsd: Double? = nil
    /// Pre-fetched card image bytes, populated alongside the price
    /// fetch in `MultiScanSession.append`. The flash overlay renders
    /// from this cached UIImage when available, falling back to
    /// AsyncImage from the URL otherwise. Skipping AsyncImage's
    /// network round-trip + default fade-in makes the flash feel
    /// instantaneous instead of a ~300-500ms delayed pop. Memory
    /// footprint is one decoded image per tray entry — well under
    /// 1MB each at the URL's typical resolution.
    var cachedImage: UIImage? = nil
    /// Source JPEG the user actually scanned, retained so the per-row
    /// correction picker can submit a server-side `user_correction`
    /// anchor via `ScanPickerSheet`'s existing bytes-based promote
    /// path (the picker only fires correction inside its `if let
    /// bytes = scanImage` branch). Nil for server-routed scans
    /// (the bytes are already at `scan-uploads/<hash>.jpg`, but the
    /// picker doesn't currently support hash-only correction in this
    /// PR — server-routed corrections silently skip the anchor
    /// submission). Memory: ~400KB per entry; ~20MB for a typical
    /// 50-row session.
    var scanImage: UIImage? = nil
}

// MARK: - MultiScanSession
//
// MainActor-bound so SwiftUI views can observe `entries` directly.
// Owned by the ScannerTabView via @StateObject so the tray persists
// across the tab life. Cross-launch persistence is out of scope.

@MainActor
final class MultiScanSession: ObservableObject {
    @Published private(set) var entries: [MultiScanEntry] = []

    /// Window (seconds) within which a repeat scan of the same slug
    /// from auto-detect is considered a "same card lingering in
    /// viewfinder" duplicate. 3s comfortably covers the user reaching
    /// for the next card in a pack flow without blocking deliberate
    /// re-scans (e.g., the user intentionally scans two copies of the
    /// same card — they'd naturally take longer than 3s between).
    private let autoDetectDedupeWindow: TimeInterval = 3.0

    /// Minimum wall-clock gap between successive auto-detect appends,
    /// independent of slug. The slug-dedupe window only catches re-reads of
    /// the SAME card; a slight hand-shift can produce a fresh stable
    /// rectangle with a slightly different read that bypasses it and fires
    /// again within ~0.5s. This floor makes multi-scan feel like "one card
    /// per second" and gives the user time to move to the next card.
    private let autoDetectMinInterval: TimeInterval = 1.0

    /// Sum of (marketPriceUsd × quantity) across entries with a loaded
    /// price. Loading entries contribute 0; the running total fills in
    /// as price fetches resolve.
    var totalUsd: Double {
        entries.reduce(0.0) { acc, e in
            acc + (e.marketPriceUsd.map { $0 * Double(e.quantity) } ?? 0.0)
        }
    }

    /// Returns true when the caller should skip an auto-detect append
    /// because the same slug already landed in the tray within the
    /// dedupe window. Derived from `entries.last` (rather than
    /// separately-tracked state) so any path that removes the most-
    /// recent entry — clear, swipe-delete, submit success — naturally
    /// invalidates the dedupe and lets the user re-scan the same card
    /// immediately. Only meaningful for auto-detect entries; tap/
    /// library are deliberate user actions and bypass this check.
    func shouldDedupeAutoDetect(slug: String) -> Bool {
        guard let last = entries.last,
              last.match.slug == slug else {
            return false
        }
        return Date().timeIntervalSince(last.scannedAt) < autoDetectDedupeWindow
    }

    /// Returns true when the caller should skip an auto-detect append
    /// because the most recent entry landed less than `autoDetectMinInterval`
    /// ago — a wall-clock floor that throttles rapid re-fires regardless of
    /// slug. Like the dedupe check it derives from `entries.last`, so any
    /// path that removes the most-recent entry (clear, swipe-delete, submit)
    /// naturally re-arms. Auto-detect only; tap/library bypass it.
    func shouldThrottleAutoDetect() -> Bool {
        guard let last = entries.last else { return false }
        return Date().timeIntervalSince(last.scannedAt) < autoDetectMinInterval
    }

    /// Append a card produced by `runIdentify`. Caller has already
    /// filtered out LOW confidence. Kicks off the price fetch as a
    /// background Task so the row paints immediately. The dedupe
    /// state for the next auto-detect fire comes from `entries.last`
    /// (set here by the append itself) — no separate tracking needed.
    func append(
        match: ScanMatch,
        candidates: [ScanMatch],
        confidence: String,
        imageHash: String?,
        scanLanguage: ScanLanguage,
        scanImage: UIImage? = nil,
    ) {
        var entry = MultiScanEntry(
            id: UUID(),
            match: match,
            candidates: candidates,
            confidence: confidence,
            scannedAt: Date(),
            imageHash: imageHash,
            scanLanguage: scanLanguage,
        )
        entry.scanImage = scanImage
        entries.append(entry)
        loadPrice(for: entry.id, slug: match.slug)
        loadImage(for: entry.id, urlString: match.mirroredPrimaryImageUrl)
        loadPrintings(for: entry.id, slug: match.slug)
    }

    func remove(at offsets: IndexSet) {
        entries.remove(atOffsets: offsets)
    }

    func remove(entryId: UUID) {
        entries.removeAll { $0.id == entryId }
    }

    func updateQuantity(entryId: UUID, qty: Int) {
        guard let idx = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[idx].quantity = max(1, min(99, qty))
    }

    /// Pin (or clear, with nil) the finish for a row. The bulk-add
    /// submission threads this through as `printing_id`.
    func updatePrinting(entryId: UUID, printingId: String?) {
        guard let idx = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[idx].printingId = printingId
    }

    /// Replace the matched card on an existing entry (per-row
    /// correction from the review sheet). Clears the cached price +
    /// image because both are slug-specific and stale for the new
    /// match, then kicks off fresh fetches in the same pattern as
    /// append. The bulk-add submission for this entry will use the
    /// new match's canonical_slug.
    ///
    /// Caller (ScannerTabView.correctionPickerSheet) is responsible
    /// for invoking the server-side correction-promote endpoint via
    /// ScanPickerSheet's existing flow; this method only handles the
    /// client-side tray-state swap.
    func reassign(entryId: UUID, to newMatch: ScanMatch) {
        guard let idx = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[idx].match = newMatch
        entries[idx].marketPriceUsd = nil
        entries[idx].cachedImage = nil
        // The corrected card has its own finishes; the prior selection is
        // meaningless for the new slug.
        entries[idx].printingId = nil
        entries[idx].availablePrintings = []
        loadPrice(for: entryId, slug: newMatch.slug)
        loadImage(for: entryId, urlString: newMatch.mirroredPrimaryImageUrl)
        loadPrintings(for: entryId, slug: newMatch.slug)
    }

    func clear() {
        entries.removeAll()
    }

    /// Submit the tray to /api/holdings/bulk-import. On full success,
    /// clears the tray. On partial failure, keeps the failing rows so
    /// the user can retry / triage. Throws only on HTTP failure.
    func submit() async throws -> BulkScanImportSummary {
        let snapshot = entries
        let submittedIds = Set(snapshot.map { $0.id })
        let result = try await HoldingsService.shared.bulkAddFromScans(snapshot)
        // Rebuild by entry id, not by snapshot index: keep (a) snapshot
        // rows whose import failed and (b) any row scanned AFTER the
        // snapshot was taken (a card added mid-submit). The old
        // index-based rebuild from `snapshot` silently dropped a
        // mid-submit scan on both the success and partial-failure paths.
        let failedIndices = Set(result.errors.map { $0.rowIndex })
        let failedIds = Set(
            snapshot.enumerated().compactMap { failedIndices.contains($0.offset) ? $0.element.id : nil }
        )
        entries = entries.filter { entry in
            !submittedIds.contains(entry.id) || failedIds.contains(entry.id)
        }
        return result
    }

    // MARK: - Internal

    /// Fetch this row's finishes so the tray can offer a finish menu. Same
    /// fire-and-forget pattern as loadPrice/loadImage. fetchPrintings is
    /// EN-only, so JP rows get an empty list (no menu) — matching
    /// CardDetailView. The class is @MainActor, so the Task body resumes on
    /// the main actor and can mutate `entries` directly.
    private func loadPrintings(for entryId: UUID, slug: String) {
        Task { [weak self] in
            let printings = (try? await CardService.shared.fetchPrintings(slug: slug)) ?? []
            guard let self else { return }
            guard let idx = self.entries.firstIndex(where: { $0.id == entryId }) else { return }
            self.entries[idx].availablePrintings = printings
        }
    }

    private func loadPrice(for entryId: UUID, slug: String) {
        Task { [weak self] in
            let metrics = try? await CardService.shared.fetchCardMetrics(slug: slug)
            // Mirror the CardDetailView Near-Mint hero resolver EXACTLY
            // so the scanner price (flash overlay + tray row) matches
            // the hero the user lands on after tapping in. Raw
            // metrics.marketPrice is the 14-day median; the hero prefers
            // the freshest latest_price (EN) or the blended trusted JP
            // point (jp_latest_price / per-source pick) — keying off
            // marketPrice made the scanner show a different number than
            // the card page (owner report 2026-06-13). activeCardPrice/
            // chartFallbackPrice are detail-view-only fallback tiers the
            // scanner has no equivalent for, so pass 0/nil.
            let price = selectNearMintHeroPrice(
                isJapaneseCard: slug.hasSuffix("-jp"),
                latestPrice: metrics?.latestPrice,
                marketPrice: metrics?.marketPrice,
                jpLatestPrice: metrics?.jpLatestPrice,
                activeCardPrice: 0,
                chartFallbackPrice: nil,
                yahooJpPrice: metrics?.yahooJpPrice,
                yahooJpSampleCount: metrics?.yahooJpSampleCount,
                snkrdunkPrice: metrics?.snkrdunkPrice,
                snkrdunkSampleCount: metrics?.snkrdunkSampleCount
            )
            await MainActor.run {
                guard let self else { return }
                guard let idx = self.entries.firstIndex(where: { $0.id == entryId }) else {
                    return
                }
                // Stale-fetch guard (Codex P2 on PR #101): if the
                // entry was reassigned after this request started,
                // the entry's current match.slug will diverge from
                // the slug we fetched. Drop the result so the new
                // match's correct price (loaded by the reassign-
                // triggered fetch) isn't overwritten by the
                // late-arriving old fetch.
                guard self.entries[idx].match.slug == slug else { return }
                self.entries[idx].marketPriceUsd = price
            }
        }
    }

    /// Pre-fetch the card's primary image bytes on append so the
    /// flash overlay can render from an in-memory UIImage instead of
    /// kicking off an AsyncImage network round-trip when it's about
    /// to be shown. Silent on failure — the overlay falls back to
    /// AsyncImage's own URL load in that case, so the user sees the
    /// same placeholder + delayed pop as before.
    private func loadImage(for entryId: UUID, urlString: String?) {
        guard let urlString,
              let url = URL(string: urlString) else { return }
        Task { [weak self] in
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                guard let image = UIImage(data: data) else { return }
                await MainActor.run {
                    guard let self else { return }
                    guard let idx = self.entries.firstIndex(where: { $0.id == entryId }) else {
                        return
                    }
                    // Stale-fetch guard (Codex P2 on PR #101): drop
                    // the result if the entry was reassigned to a
                    // different match (different image URL) after
                    // the fetch was kicked off. Same reasoning as
                    // loadPrice — late old fetches would clobber the
                    // new match's correct image.
                    guard self.entries[idx].match.mirroredPrimaryImageUrl == urlString else {
                        return
                    }
                    self.entries[idx].cachedImage = image
                }
            } catch {
                // Silent. Flash falls back to AsyncImage with the URL.
            }
        }
    }
}

// MARK: - Bulk-import DTOs

struct BulkScanImportSummary {
    let inserted: Int
    let errors: [BulkScanImportError]
    var hadAnyFailures: Bool { !errors.isEmpty }
}

struct BulkScanImportError {
    let rowIndex: Int
    let message: String
}
