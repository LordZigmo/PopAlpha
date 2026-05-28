// OfflineScannerWarmup.swift
//
// App-wide entry point for warming scanner cold-start costs at launch.
// Pairs with `OfflineScanOrchestrator.shared` when the offline path is
// enabled, and still warms cheap local Vision/OCR state when scans use
// the server path.
//
// Why this exists:
//   ScannerHost is `@StateObject` inside ScannerTabView. On iOS 17+,
//   TabView lazy-evaluates tab content, so ScannerHost.init() only
//   fires when the user navigates to the Scanner tab. The previous
//   prewarm trigger lived in ScannerHost.init() and therefore only
//   ran AFTER the user opened the scanner — exactly the window we
//   were trying to absorb the cost in front of.
//
// This namespace's `startIfNeeded()` is called from:
//   - PopAlphaApp.body.task (priority .utility) — fires at app launch,
//     so the local OCR cost and, when enabled, the 9s catalog+model+
//     SigLIP load run while the user is on the homepage / market /
//     portfolio.
//   - ScannerHost.init() — redundant fallback in case the App-level
//     trigger somehow doesn't fire (test runners, future refactor).
//     The dispatchOnce guard makes the second call a no-op.

import Foundation
import OSLog
import UIKit

enum OfflineScannerWarmup {
    /// Local Vision/OCR warmup is useful for every scanner path,
    /// including the current TestFlight server-routed path. Offline
    /// orchestrator warmup is tracked separately because the heavy
    /// SigLIP load is tracked separately because the offline path is
    /// still gated by its feature flag while scanner access remains
    /// free.
    private static let localStarted = AtomicBool(initialValue: false)
    private static let offlineStarted = AtomicBool(initialValue: false)

    /// Fire-and-forget warmup. Always warms the cheap local OCR state;
    /// conditionally warms the offline orchestrator when the feature
    /// flag is enabled. .utility priority so it competes minimally
    /// with active UI work.
    static func startIfNeeded() async {
        async let warmLocal: Void = startLocalWarmupIfNeeded()
        async let warmOffline: Void = startOfflineWarmupIfNeeded()
        _ = await (warmLocal, warmOffline)
    }

    private static func startLocalWarmupIfNeeded() async {
        guard localStarted.compareAndSwap(expected: false, desired: true) else { return }
        await prewarmOCR()
    }

    private static func startOfflineWarmupIfNeeded() async {
        let enabled = await MainActor.run { PremiumGate.shared.offlineScannerEnabled }
        guard enabled else { return }
        guard offlineStarted.compareAndSwap(expected: false, desired: true) else { return }

        // Catalog + CoreML SigLIP model + dummy embed + dummy kNN
        // (forces fp16 expansion). Kept behind the offline gate because
        // it is the expensive part of scanner warmup.
        await OfflineScanOrchestrator.shared.prewarm()
    }

    private static func prewarmOCR() async {
        let t0 = Date()
        // Synthetic image just needs to drive Vision through one full
        // recognition pass. Mid-gray 256×256 is enough — Vision sees
        // no text but still goes through detector init.
        let size = CGSize(width: 256, height: 256)
        let renderer = UIGraphicsImageRenderer(size: size)
        let dummy = renderer.image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        _ = await OCRService.extractCardIdentifiersMulti(from: dummy)
        let elapsed = Date().timeIntervalSince(t0) * 1000
        Logger.scan.debug("prewarm_ocr: total=\(String(format: "%.1f", elapsed))ms")
    }
}

/// Tiny atomic bool wrapper for the dispatchOnce-style guard.
/// Foundation has no built-in AtomicBool; using NSLock around a
/// Bool is fine for the single check + flip we need.
private final class AtomicBool: @unchecked Sendable {
    private var value: Bool
    private let lock = NSLock()

    init(initialValue: Bool) {
        self.value = initialValue
    }

    func compareAndSwap(expected: Bool, desired: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard value == expected else { return false }
        value = desired
        return true
    }

    func store(_ newValue: Bool) {
        lock.lock()
        value = newValue
        lock.unlock()
    }
}
