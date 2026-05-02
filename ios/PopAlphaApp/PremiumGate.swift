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
//   2. Feature toggles. `offlineScannerEnabled` is gated by
//      "is pro AND offline scanner feature flag enabled" — keeping
//      the conjunction in one place lets us flip features on/off
//      without touching call sites.
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

    /// Convenience: is the offline scanner unlocked? Keep the
    /// conjunction here so feature flips don't sprawl across the
    /// codebase. Today this is just `isPro`; later we might add
    /// a remote feature flag check (e.g., GrowthBook gradual rollout).
    @Published public private(set) var offlineScannerEnabled: Bool = false

    public init(store: PremiumStore = .shared) {
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
        // Future expansion: && featureFlag("offline_scanner") here.
        let offlineFlag = effectivePro
        if offlineScannerEnabled != offlineFlag {
            offlineScannerEnabled = offlineFlag
        }
    }
}
