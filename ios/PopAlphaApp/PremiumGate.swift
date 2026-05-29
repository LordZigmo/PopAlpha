// PremiumGate.swift
//
// Single chokepoint that callers ask "is the user pro right now?"
// Doesn't talk to StoreKit directly — it observes `PremiumStore`
// and adds a DEBUG override layer for QA / development.
//
// WHY A SEPARATE GATE LAYER:
//
//   1. PremiumStore is platform-coupled (StoreKit 2 = iOS 15+).
//      Any code that just needs "is the user pro" should NOT have
//      to import StoreKit. Gate exposes a plain `Bool`.
//
//   2. Feature toggles. `offlineScannerEnabled` mirrors the offline
//      scanner feature flag in one place so scanner routing can flip
//      without touching call sites. Scanner access is intentionally
//      free; Pro gates market/collector intelligence, not identify.
//
//   3. DEBUG override. During development we want to flip pro on
//      without making real purchases. This layer reads a
//      UserDefaults toggle (`-debugPremiumOverride`) that's checked
//      before the real entitlement. NEVER compiled into release
//      builds — `#if DEBUG` enforces it.
//
// USAGE:
//
//   if PremiumGate.shared.offlineScannerEnabled {
//       // hot path: on-device CoreML inference + catalog lookup
//   } else {
//       // existing path: server-side identify
//   }
//
// THREADING:
//
//   PremiumStore is @MainActor; this gate is @MainActor too. Reads
//   are O(1) — bool comparisons over published state. Don't call
//   from background queues; the bool is meant to drive UI
//   conditionals on the main actor.

import Foundation
import Combine

@MainActor
public final class PremiumGate: ObservableObject {

    public static let shared = PremiumGate()

    // MARK: - Inputs

    private let store: PremiumStore
    private var cancellables: Set<AnyCancellable> = []

    // MARK: - Published outputs

    /// Re-publishes `PremiumStore.status` so SwiftUI views can bind
    /// directly to the gate without importing StoreKit.
    @Published public private(set) var isPro: Bool = false

    /// Convenience: is the offline scanner enabled? Scanner access is
    /// free, so this flag is not tied to Pro. During the scanner-
    /// accuracy sprint this stays false so scans route through the
    /// centrally trained server/model path.
    @Published public private(set) var offlineScannerEnabled: Bool = false

    // MARK: - Free AI-analysis budget (device-scoped; counts signed-out)

    /// Free / anonymous users get the full AI analysis on up to this many
    /// distinct cards; beyond that the analysis renders behind the Pro
    /// invisible-ink lock. Device-scoped (UserDefaults) so it applies even
    /// when signed out, and keyed by slug so revisiting an already-unlocked
    /// card doesn't burn another view.
    public static let freeAnalysisLimit = 3
    private static let freeAnalysisSeenKey = "ai.popalpha.freeAnalysisSeenSlugs"

    /// Count of distinct cards a free user has spent on the full analysis.
    /// Published so any "N of 3 free reads" UI can react.
    @Published public private(set) var freeAnalysisSeenCount: Int = 0
    private var freeAnalysisSeenSlugs: Set<String> = []

    public convenience init() {
        self.init(store: PremiumStore.shared)
    }

    public init(store: PremiumStore) {
        self.store = store

        // Bind the store's published status to our flags.
        store.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.recompute(from: status)
            }
            .store(in: &cancellables)

        // Initial seed (published-property-binding fires async on
        // first sink registration; recompute synchronously so the
        // initial UI is correct).
        recompute(from: store.status)

        freeAnalysisSeenSlugs = Set(
            UserDefaults.standard.stringArray(forKey: Self.freeAnalysisSeenKey) ?? []
        )
        freeAnalysisSeenCount = freeAnalysisSeenSlugs.count
    }

    // MARK: - DEBUG override

    /// Force the gate to consider the user as pro for QA. Only
    /// honored in DEBUG builds — release builds always defer to
    /// StoreKit. Persisted to UserDefaults so a toggled state
    /// survives app restarts during a test session.
    public static let debugOverrideKey = "ai.popalpha.premium.debugOverride"

    public var debugOverrideEnabled: Bool {
        get {
            #if DEBUG
            return UserDefaults.standard.bool(forKey: Self.debugOverrideKey)
            #else
            return false
            #endif
        }
        set {
            #if DEBUG
            UserDefaults.standard.set(newValue, forKey: Self.debugOverrideKey)
            recompute(from: store.status)
            #endif
        }
    }

    // MARK: - Internal

    private func recompute(from status: PremiumStatus) {
        let realPro = status.isPro
        #if DEBUG
        let effectivePro = realPro || debugOverrideEnabled
        #else
        let effectivePro = realPro
        #endif
        if isPro != effectivePro { isPro = effectivePro }
        let offlineFlag = FeatureFlags.isOfflineScannerEnabled
        if offlineScannerEnabled != offlineFlag {
            offlineScannerEnabled = offlineFlag
        }
    }

    // MARK: - Free analysis budget

    /// Whether the full AI analysis should be revealed for `slug`. Pro
    /// unlocks everything; otherwise a card already revealed stays
    /// revealed, and new cards are allowed until the free limit is hit.
    public func canRevealAnalysis(slug: String) -> Bool {
        if isPro { return true }
        if freeAnalysisSeenSlugs.contains(slug) { return true }
        return freeAnalysisSeenSlugs.count < Self.freeAnalysisLimit
    }

    /// Record that a free user saw the full analysis for `slug`. No-op for
    /// Pro (unlimited — shouldn't consume budget), already-counted cards,
    /// and once the limit is reached. Persists across launches.
    public func recordAnalysisReveal(slug: String) {
        guard !isPro,
              !freeAnalysisSeenSlugs.contains(slug),
              freeAnalysisSeenSlugs.count < Self.freeAnalysisLimit else { return }
        freeAnalysisSeenSlugs.insert(slug)
        freeAnalysisSeenCount = freeAnalysisSeenSlugs.count
        UserDefaults.standard.set(Array(freeAnalysisSeenSlugs), forKey: Self.freeAnalysisSeenKey)
    }
}
