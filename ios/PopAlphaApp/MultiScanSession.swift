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
    var quantity: Int = 1
    var grade: String = "RAW"
    var printingId: String? = nil
    /// Loaded async via CardService.fetchCardMetrics. Nil = still
    /// loading or unknown. Drives the per-row price label and the
    /// running tray total.
    var marketPriceUsd: Double? = nil
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
    ) {
        let entry = MultiScanEntry(
            id: UUID(),
            match: match,
            candidates: candidates,
            confidence: confidence,
            scannedAt: Date(),
            imageHash: imageHash,
        )
        entries.append(entry)
        loadPrice(for: entry.id, slug: match.slug)
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

    func clear() {
        entries.removeAll()
    }

    /// Submit the tray to /api/holdings/bulk-import. On full success,
    /// clears the tray. On partial failure, keeps the failing rows so
    /// the user can retry / triage. Throws only on HTTP failure.
    func submit() async throws -> BulkScanImportSummary {
        let snapshot = entries
        let result = try await HoldingsService.shared.bulkAddFromScans(snapshot)
        if result.errors.isEmpty {
            entries.removeAll()
        } else {
            let failedIndices = Set(result.errors.map { $0.rowIndex })
            entries = snapshot.enumerated().compactMap { (i, e) in
                failedIndices.contains(i) ? e : nil
            }
        }
        return result
    }

    // MARK: - Internal

    private func loadPrice(for entryId: UUID, slug: String) {
        Task { [weak self] in
            let metrics = try? await CardService.shared.fetchCardMetrics(slug: slug)
            let price = metrics?.marketPrice
            await MainActor.run {
                guard let self else { return }
                guard let idx = self.entries.firstIndex(where: { $0.id == entryId }) else {
                    return
                }
                self.entries[idx].marketPriceUsd = price
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
