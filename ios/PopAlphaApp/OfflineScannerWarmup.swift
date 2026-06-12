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
// Two-stage warmup, split so the heavy work can never race the camera:
//   - `startIfNeeded()` — CHEAP local OCR pass only. Called from
//     PopAlphaApp.body.task at app launch and from ScannerHost.init()
//     (idempotent). Safe anywhere; never touches the CoreML model.
//   - `startOfflineModelIfEnabled()` — the HEAVY catalog + 177MB SigLIP
//     load. Called from ScannerHost's first-frame transition ONLY, so
//     it runs after the camera preview is already live. Running it at
//     launch starved camera bring-up and blacked out the preview
//     (2026-05-05 "5s black page"; 2026-06-12 "black forever").

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

    /// Cheap warmup only — one Vision/OCR recognition pass. Safe to
    /// call at app launch AND at scanner-tab activation because it
    /// never triggers the heavy CoreML model load, so it can't contend
    /// with camera bring-up. The offline model is warmed separately,
    /// AFTER the camera renders its first frame, via
    /// `startOfflineModelIfEnabled()`.
    static func startIfNeeded() async {
        await startLocalWarmupIfNeeded()
    }

    /// Heavy offline warmup: catalog parse + 177 MB CoreML SigLIP load
    /// + dummy embed + dummy kNN (fp16 scratch expansion). This is the
    /// work that starved camera startup and blacked out the scanner
    /// preview when it ran during launch — real-device 2026-05-05 "5s
    /// black scanner page", then 2026-06-12 "black FOREVER" once
    /// offline-first shipped (#257) and this path ran on every launch
    /// again after 3 weeks dormant. Call ONLY after the camera has
    /// produced its first frame: the preview is live by then, so the
    /// model load competes for Neural Engine / CPU *behind* a visible
    /// viewfinder instead of in front of a black one. No-op when the
    /// offline flag is off or the model is already warmed (dispatchOnce
    /// guard), so it's safe to call on every first-frame transition.
    static func startOfflineModelIfEnabled() async {
        await startOfflineWarmupIfNeeded()
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
