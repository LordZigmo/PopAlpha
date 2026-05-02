// PremiumStore.swift
//
// StoreKit 2 wrapper. Owns the live transaction listener +
// entitlement cache. UI layers (paywall, settings, scanner premium
// gate) bind to `@Published var status` rather than calling
// StoreKit directly.
//
// LIFECYCLE:
//
//   1. App launch:
//      - `PremiumStore.shared` constructed lazily on first access.
//      - `start()` kicks off `transactionListenerTask` (StoreKit's
//        `Transaction.updates` async sequence) for the lifetime of
//        the process. This catches subscription renewals + revocations
//        delivered while the app is running.
//      - `refreshStatus()` is called once on init so the cached
//        entitlement reflects what the App Store thinks RIGHT NOW
//        (handles "user paid on another device" within seconds of
//        launch).
//
//   2. User taps a paywall button:
//      - `loadProducts()` fetches localized `Product` objects from
//        StoreKit if not already cached. Errors here are network /
//        ASC config issues; surface a "try again" UI.
//      - `purchase(_ product: Product)` runs the system's
//        purchase sheet. Returns a `PurchaseOutcome` so the caller
//        can branch on success/cancel/pending.
//
//   3. User restores purchases (Settings):
//      - `restorePurchases()` calls `AppStore.sync()` which forces
//        a refresh of the device's StoreKit cache against Apple's
//        server, then re-runs `refreshStatus()`.
//
// ENTITLEMENT MODEL:
//
//   We treat a user as "pro" if Transaction.currentEntitlements
//   contains ANY of `PremiumProducts.proEntitlementProductIDs` AND
//   that transaction is not revoked / refunded / past its expiration
//   (StoreKit handles the date math; we just check `revocationDate
//   == nil` and `productID` matches).
//
// CACHING:
//
//   The entitlement is cached to UserDefaults so on next launch we
//   render the correct UI INSTANTLY (no flash of free-tier UI while
//   StoreKit boots). The async refresh fires in parallel and
//   reconciles. Subscription EXPIRATION dates aren't cached — if a
//   sub expires while the app is closed, we briefly show "pro" UI
//   on launch then downgrade once `refreshStatus()` returns. This
//   ~2s flicker is acceptable for v1; v2 could cache expiration too.
//
// TESTING:
//
//   - `Products.storekit` configuration file (in PopAlphaApp.xcodeproj)
//     mocks the products locally. Run with the scheme's StoreKit
//     Configuration setting pointing at it for purchase-flow QA
//     without a real ASC subscription.
//   - For headless tests we expose `PremiumStore.preview()` which
//     returns a store wired to in-memory mock state.

import Foundation
import StoreKit

@MainActor
public final class PremiumStore: ObservableObject {

    // MARK: - Singleton

    public static let shared = PremiumStore()

    // MARK: - Public state

    /// Loaded products keyed by ID. Populated by `loadProducts()`.
    @Published public private(set) var products: [String: Product] = [:]

    /// Live entitlement status. Pulls from cached UserDefaults at
    /// init for instant UI; refreshed async via StoreKit.
    @Published public private(set) var status: PremiumStatus

    /// Whether `loadProducts()` has succeeded at least once.
    @Published public private(set) var productsLoaded: Bool = false

    /// Last error from product loading or purchase, surfaced for UI
    /// to display ("couldn't reach App Store; try again").
    @Published public private(set) var lastError: String?

    // MARK: - Internal state

    private var transactionListenerTask: Task<Void, Never>?

    private let defaults: UserDefaults
    private static let cachedEntitlementKey = "ai.popalpha.premium.cachedEntitlement"
    private static let cachedExpirationKey = "ai.popalpha.premium.cachedExpiration"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.status = Self.loadCachedStatus(defaults: defaults)
    }

    deinit {
        transactionListenerTask?.cancel()
    }

    // MARK: - Public API

    /// Boot the store: start listening for transaction updates and
    /// refresh the current entitlement against Apple's server. Idempotent
    /// — calling more than once is a no-op for the listener task.
    public func start() {
        if transactionListenerTask == nil {
            transactionListenerTask = Task.detached(priority: .background) { [weak self] in
                guard let self else { return }
                for await verificationResult in Transaction.updates {
                    await self.handle(transactionVerificationResult: verificationResult)
                }
            }
        }
        Task { await self.refreshStatus() }
    }

    /// Asks Apple's server for the user's current entitlements and
    /// updates `status`. Costs a network round-trip; call sparingly
    /// (app launch + after explicit user action like Restore).
    public func refreshStatus() async {
        var resolved: PremiumStatus = .free
        for await verificationResult in Transaction.currentEntitlements {
            guard let transaction = try? checkVerified(verificationResult) else { continue }
            if PremiumProducts.proEntitlementProductIDs.contains(transaction.productID) {
                if transaction.revocationDate == nil {
                    let expiration = transaction.expirationDate
                    resolved = .pro(expirationDate: expiration)
                    break
                }
            }
        }
        await MainActor.run {
            self.status = resolved
            self.persistCachedStatus(resolved)
        }
    }

    /// Fetch product metadata (price strings, localized titles) for
    /// every product ID we sell. Cheap enough to call on app launch
    /// or paywall first-render. Sets `productsLoaded = true` on success.
    public func loadProducts() async {
        do {
            let fetched = try await Product.products(for: PremiumProducts.allProductIDs)
            var byID: [String: Product] = [:]
            for p in fetched { byID[p.id] = p }
            await MainActor.run {
                self.products = byID
                self.productsLoaded = true
                self.lastError = nil
            }
        } catch {
            await MainActor.run {
                self.lastError = "Couldn't load products: \(error.localizedDescription)"
            }
        }
    }

    /// Initiate a purchase. Returns the outcome so callers can branch
    /// on .success vs .userCancelled vs .pending (parental approval
    /// flow). Throws if StoreKit itself errors — network unreachable,
    /// account not signed in.
    public func purchase(_ product: Product) async throws -> PurchaseOutcome {
        let result = try await product.purchase()
        switch result {
        case .success(let verificationResult):
            let transaction = try checkVerified(verificationResult)
            // ALWAYS finish the transaction — Apple won't deliver the
            // next update otherwise, and StoreKit will keep replaying
            // the same purchase on every launch.
            await transaction.finish()
            await refreshStatus()
            return .success
        case .userCancelled:
            return .userCancelled
        case .pending:
            return .pending
        @unknown default:
            return .pending
        }
    }

    /// Force a sync against Apple's server for restoration UX
    /// ("I bought this on another device"). May briefly show a
    /// system sign-in prompt.
    public func restorePurchases() async {
        do {
            try await AppStore.sync()
            await refreshStatus()
        } catch {
            await MainActor.run {
                self.lastError = "Restore failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Verification + transaction handling

    private func handle(transactionVerificationResult result: VerificationResult<Transaction>) async {
        guard let transaction = try? checkVerified(result) else { return }
        await transaction.finish()
        await refreshStatus()
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .verified(let value):
            return value
        case .unverified(_, let error):
            throw error
        }
    }

    // MARK: - Caching

    private func persistCachedStatus(_ status: PremiumStatus) {
        switch status {
        case .free:
            defaults.removeObject(forKey: Self.cachedEntitlementKey)
            defaults.removeObject(forKey: Self.cachedExpirationKey)
        case .pro(let expiration):
            defaults.set(PremiumEntitlement.pro.rawValue, forKey: Self.cachedEntitlementKey)
            if let exp = expiration {
                defaults.set(exp.timeIntervalSince1970, forKey: Self.cachedExpirationKey)
            } else {
                defaults.removeObject(forKey: Self.cachedExpirationKey)
            }
        }
    }

    private static func loadCachedStatus(defaults: UserDefaults) -> PremiumStatus {
        guard let raw = defaults.string(forKey: cachedEntitlementKey),
              let entitlement = PremiumEntitlement(rawValue: raw) else {
            return .free
        }
        switch entitlement {
        case .pro:
            let stamp = defaults.double(forKey: cachedExpirationKey)
            // 0.0 is "no expiration cached" = lifetime OR unknown.
            // If we DID cache an expiration and it's in the past,
            // assume free until refreshStatus reconciles.
            if stamp > 0 {
                let exp = Date(timeIntervalSince1970: stamp)
                if exp < Date() { return .free }
                return .pro(expirationDate: exp)
            }
            return .pro(expirationDate: nil)
        }
    }
}

// MARK: - Status types

public enum PremiumStatus: Equatable, Sendable {
    case free
    case pro(expirationDate: Date?)

    public var isPro: Bool {
        if case .pro = self { return true }
        return false
    }

    public var expirationDate: Date? {
        if case .pro(let date) = self { return date }
        return nil
    }
}

public enum PurchaseOutcome: Equatable, Sendable {
    case success
    case userCancelled
    case pending  // parental approval, etc.
}
