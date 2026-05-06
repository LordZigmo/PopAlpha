// PremiumProducts.swift
//
// Single source of truth for the App Store product IDs we want to
// sell — defined in a top-level enum so PremiumStore (StoreKit 2
// wrapper), PremiumGate (entitlement facade), Products.storekit
// (local test config), and any paywall UI all reference the SAME
// strings. Renaming a product = one change here.
//
// Product IDs are reverse-DNS scoped to PopAlpha and prefixed with
// the pricing model — Apple recommends this so the App Store
// dashboard reads cleanly. Final product strings need to match what
// gets registered in App Store Connect; for local development the
// matching Products.storekit configuration file mocks them.
//
// PRICING TIERS (subject to revision before submission):
//
//   Pro Monthly  — auto-renewing subscription, 1 month period
//                  Unlocks: offline scanner (catalog + on-device
//                  CoreML inference), sub-second scan latency,
//                  unlimited scans (free tier capped post-quota).
//
//   Pro Yearly   — auto-renewing subscription, 1 year period
//                  Same entitlement as monthly with annual discount.
//                  Defaults to ~16% savings vs 12 × monthly.

import Foundation

public enum PremiumProducts {
    public static let proMonthly = "ai.popalpha.premium.pro.monthly"
    public static let proYearly = "ai.popalpha.premium.pro.yearly"

    /// All registered product IDs. StoreKit's `Product.products(for:)`
    /// fetches the full catalog from this list.
    public static let allProductIDs: Set<String> = [
        proMonthly,
        proYearly,
    ]

    /// Product IDs that grant the "pro" entitlement. Adding a new
    /// SKU (e.g. proSemiAnnual) requires adding it here AND in
    /// App Store Connect's subscription group.
    public static let proEntitlementProductIDs: Set<String> = [
        proMonthly,
        proYearly,
    ]
}

/// Top-level entitlements granted by an active subscription /
/// non-consumable purchase. Currently a single tier; if we add e.g.
/// a "team" plan or lifetime-only flags later, extend this enum.
public enum PremiumEntitlement: String, Sendable {
    case pro
}
