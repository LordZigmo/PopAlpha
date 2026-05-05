// OfflineScannerWarmup.swift
//
// App-wide entry point for warming the offline scanner pipeline at
// launch. Pairs with `OfflineScanOrchestrator.shared`.
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
//     so the 9s catalog+model+SigLIP load runs while the user is on
//     the homepage / market / portfolio.
//   - ScannerHost.init() — redundant fallback in case the App-level
//     trigger somehow doesn't fire (test runners, future refactor).
//     The dispatchOnce guard makes the second call a no-op.

import Foundation
import OSLog
import UIKit

enum OfflineScannerWarmup {
    /// Set on first call; subsequent calls return immediately. The
    /// underlying `OfflineScanOrchestrator.shared.prewarm()` is also
    /// idempotent (it coalesces against any in-flight setupTask), but
    /// we guard here too to avoid spawning multiple parallel Tasks
    /// that would all do the same work.
    private static let started = AtomicBool(initialValue: false)

    /// Fire-and-forget warmup. Gated on premium because the SigLIP
    /// model load is expensive (~2-9s of CoreML compilation) and
    /// free-tier users never use the offline path. .utility priority
    /// so it competes minimally with active UI work.
    static func startIfNeeded() async {
        guard started.compareAndSwap(expected: false, desired: true) else {
            // Already started — caller doesn't need to wait, the
            // shared orchestrator will be ready when whoever needs
            // it next awaits prewarm() / ensureReady() / identify().
            return
        }

        let enabled = await MainActor.run { PremiumGate.shared.offlineScannerEnabled }
        guard enabled else {
            // Free tier — reset the flag in case the user upgrades
            // mid-session and we want to warm then. Cheap.
            started.store(false)
            return
        }

        // Two parallel warmup tasks at the App level:
        //   1. Orchestrator: catalog + CoreML SigLIP model + dummy
        //      embed + dummy kNN (forces fp16 expansion)
        //   2. OCR: Vision's VNRecognizeTextRequest internal state
        //
        // Vision rectangle detection prewarm stays in ScannerHost
        // since it needs the engine from the view model (not
        // available until the scanner tab activates). That cost is
        // small (~700-900ms) and runs concurrently with camera
        // session startup once the user does open the tab.
        async let warmOrch: Void = OfflineScanOrchestrator.shared.prewarm()
        async let warmOCR: Void = prewarmOCR()
        _ = await (warmOrch, warmOCR)
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
