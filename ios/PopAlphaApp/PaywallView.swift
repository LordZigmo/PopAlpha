// PaywallView.swift
//
// Auto-renewable subscription paywall. Presented as a sheet from
// the scanner crown tap and the Settings → Upgrade Plan row.
//
// Apple paywall compliance (App Review 3.1.2):
//   - Title (PopAlpha Pro), period, and price-per-period are visible
//     before the user taps the CTA.
//   - Auto-renew language is shown above the CTA.
//   - Restore Purchases is one tap away.
//   - Terms of Service + Privacy Policy + Manage Subscriptions are
//     linked from the footer.
//   - All purchase logic flows through PremiumStore (StoreKit 2);
//     the local entitlement is authoritative.
//
// Pricing comes from `PremiumStore.shared.products` which is loaded
// at App.task launch. Until products are loaded the plan rows
// render skeleton placeholders so the sheet never shows a blank.

import OSLog
import StoreKit
import SwiftUI

/// Surface that opens the paywall. Drives the hero copy so a paywall
/// presented from the scanner can lead with scanner value, etc. All
/// existing call sites pass `.generic` (the default) — the contextual
/// branches are wiring for future variant tests.
public enum PaywallContext {
    case generic
    case scanner
    case collectorProfile
}

struct PaywallView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = PremiumStore.shared
    @StateObject private var gate = PremiumGate.shared

    var context: PaywallContext = .generic

    @State private var selectedProductID: String = PremiumProducts.proYearly
    @State private var isPurchasing: Bool = false
    @State private var errorMessage: String? = nil
    @State private var pendingMessage: String? = nil
    // Per-product intro-offer eligibility, keyed by product ID. Empty
    // until `.task` resolves; lookup falls back to "true" (optimistic)
    // so the trial copy renders during the brief async window for
    // first-time users (the common case). Updated for every product
    // that carries a subscription.
    @State private var eligibilityByProductID: [String: Bool] = [:]

    // MARK: - Trial offer state machine
    //
    // Three states drive every trial-aware piece of copy on the
    // paywall — CTA, supporting line, plan badge, plan subtitle, and
    // auto-renew disclosure:
    //
    //   .eligible — StoreKit returned an intro offer for this product
    //               AND the user passes Apple's per-Apple-ID
    //               isEligibleForIntroOffer check (or the check
    //               hasn't resolved yet — optimistic default).
    //   .unknown  — We have a trial configured for this product
    //               (per ASC + the local Products.storekit), but the
    //               StoreKit response doesn't expose an offer right
    //               now. Common reasons: ASC offer pending review,
    //               TestFlight/sandbox lag, or a stale local cache.
    //               Surface "Try 7 days free" + the eligible-new-
    //               subscribers caveat so the user isn't told there's
    //               a trial that never applies.
    //   .noTrial  — No trial in the StoreKit response AND we don't
    //               expect one for this product. Or the user is
    //               confirmed ineligible (already redeemed). Falls
    //               back to plain "Start Pro" copy.
    //
    // `productsWithKnownTrialConfig` is the source of truth for
    // "products we EXPECT to carry a trial." Add a product ID here
    // when configuring an intro offer in App Store Connect; remove
    // it when the offer is taken down. This is what lets the .unknown
    // fallback know there's something Apple should be serving but
    // isn't.

    private enum TrialState {
        case eligible
        case unknown
        case noTrial
    }

    private static let productsWithKnownTrialConfig: Set<String> = [
        PremiumProducts.proYearly,
    ]

    private func isEligibleForTrial(productID: String) -> Bool {
        // Optimistic default: treat as eligible until StoreKit reports.
        // First-time users — by far the common case — ARE eligible, so
        // showing trial copy during the brief loading window is the
        // right call. After `.task` resolves we have the real value.
        eligibilityByProductID[productID] ?? true
    }

    private func trialState(forProductID productID: String) -> TrialState {
        if let product = store.products[productID] {
            // Product loaded — trust the StoreKit response.
            if let intro = product.subscription?.introductoryOffer,
               intro.paymentMode == .freeTrial {
                return isEligibleForTrial(productID: productID) ? .eligible : .noTrial
            }
            // No offer in the response. If we expect one (per the
            // locally-known config), Apple is probably lagging — show
            // the safer fallback rather than hide the trial entirely.
            return Self.productsWithKnownTrialConfig.contains(productID) ? .unknown : .noTrial
        }
        // Products haven't loaded yet. Render trial copy optimistically
        // for products we know carry one; covers the brief loading
        // window so the CTA doesn't flash through "Start Pro" → trial.
        return Self.productsWithKnownTrialConfig.contains(productID) ? .eligible : .noTrial
    }

    /// Convenience for non-CTA call sites that just need to know
    /// "should this row show trial-flavored copy?". Both .eligible and
    /// .unknown surface trial messaging; .noTrial does not.
    private func showsTrialCopy(forProductID productID: String) -> Bool {
        trialState(forProductID: productID) != .noTrial
    }

    private var selectedTrialState: TrialState {
        trialState(forProductID: selectedProductID)
    }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    closeButton
                    hero
                    benefits
                    plans
                    purchaseDisclosure
                    purchaseActions
                    statusMessages
                    footerLinks
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 20)
            }
        }
        .task {
            // Products are usually pre-loaded at App.task; trigger again
            // on first paywall open in case the network was offline at
            // launch.
            if !store.productsLoaded {
                await store.loadProducts()
            }
            // Per-Apple-ID intro offer eligibility check. Returns false
            // for users who already redeemed the trial (or who already
            // have an active sub). Resolves for every loaded product
            // that carries a subscription so the CTA reflects the
            // currently-selected plan.
            for (productID, product) in store.products {
                if let subscription = product.subscription {
                    eligibilityByProductID[productID] = await subscription.isEligibleForIntroOffer
                }
            }
            // Diagnostic: each product's intro-offer + eligibility
            // state. If the simulator/device is rendering "Start Pro"
            // for yearly when a trial IS configured, the log shows
            // which leg of the state machine we landed on (offer
            // missing from StoreKit response vs. eligibility false).
            for productID in PremiumProducts.allProductIDs {
                let product = store.products[productID]
                let hasOffer = product?.subscription?.introductoryOffer != nil
                let eligible = eligibilityByProductID[productID] ?? false
                Logger.api.info("[paywall] product=\(productID) loaded=\(product != nil) introOffer=\(hasOffer) eligible=\(eligible) state=\(String(describing: self.trialState(forProductID: productID)))")
            }
        }
        .onChange(of: gate.isPro) { _, isProNow in
            // Auto-dismiss the moment the user becomes pro (purchase or
            // restore), so they don't have to tap close.
            if isProNow { dismiss() }
        }
    }

    // MARK: - Header

    private var closeButton: some View {
        HStack {
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    .frame(width: 32, height: 32)
                    .background(PA.Colors.surface)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    private var hero: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(PA.Colors.gold.opacity(0.12))
                    .frame(width: 60, height: 60)
                Image(systemName: "crown.fill")
                    .font(.system(size: 26))
                    .foregroundStyle(PA.Colors.gold.opacity(0.95))
            }

            Text("PopAlpha Pro")
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.text)

            // Prominent value prop — leads the paywall narrative.
            Text(heroHeadline)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(PA.Colors.text)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 320)

            // Smaller supporting line under the value prop.
            Text(heroSubheadline)
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 320)
        }
    }

    /// Prominent value prop. Driven by the surface that opened the
    /// paywall so a scanner-triggered open can lead with scanner copy.
    private var heroHeadline: String {
        switch context {
        case .generic:
            return "Make smarter Pokémon card decisions."
        case .scanner:
            return "Unlock faster card scanning"
        case .collectorProfile:
            return "Unlock your collector profile"
        }
    }

    /// Smaller supporting line under the headline. Same context split.
    private var heroSubheadline: String {
        switch context {
        case .generic:
            return "Unlock Pro signals, collector insights, and faster scanning built around your collection."
        case .scanner:
            return "Scan quickly, identify cards offline, and turn every scan into a market read."
        case .collectorProfile:
            return "See your collection style, radar chart, and AI insights tuned to the cards you own."
        }
    }

    // MARK: - Benefits

    private var benefits: some View {
        // Order is intentional: lead with the more differentiated and
        // emotionally compelling value (insights > signals > offline
        // scanning). Offline scanning is useful but not the strongest
        // first sell.
        VStack(spacing: 8) {
            benefitRow(
                icon: "person.crop.square.filled.and.at.rectangle",
                title: "Collector Insights",
                subtitle: "See your radar profile, collection style, and AI reads tuned to the cards you own.",
            )
            benefitRow(
                icon: "chart.line.uptrend.xyaxis",
                title: "Pro Market Signals",
                subtitle: "See which cards are gaining momentum, breaking out, or moving into better buy ranges.",
            )
            benefitRow(
                icon: "wifi.slash",
                title: "Faster offline scanning",
                subtitle: "Identify cards quickly, even with a weak connection.",
            )
        }
    }

    private func benefitRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(PA.Colors.accentSoft)
                    .frame(width: 40, height: 40)
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(PA.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(PA.Colors.border, lineWidth: 1)
        )
    }

    // MARK: - Plan selector

    private var plans: some View {
        VStack(spacing: 10) {
            planRow(
                productID: PremiumProducts.proYearly,
                badge: planBadge(for: PremiumProducts.proYearly),
            )
            planRow(
                productID: PremiumProducts.proMonthly,
                badge: planBadge(for: PremiumProducts.proMonthly),
            )
        }
    }

    /// Plan-row badge. Trial states (eligible OR unknown) show
    /// "7 days free" so the row visually signals a trial exists even
    /// when StoreKit is mid-load. .noTrial yearly falls back to the
    /// savings badge; .noTrial monthly has no badge.
    private func planBadge(for productID: String) -> String? {
        if showsTrialCopy(forProductID: productID) {
            return "7 days free"
        }
        if productID == PremiumProducts.proYearly {
            return "Save 37%"
        }
        return nil
    }

    private func planRow(productID: String, badge: String?) -> some View {
        let product = store.products[productID]
        let isSelected = selectedProductID == productID
        return Button {
            selectedProductID = productID
            PAHaptics.tap()
        } label: {
            HStack(alignment: .center, spacing: 12) {
                ZStack {
                    Circle()
                        .strokeBorder(isSelected ? PA.Colors.accent : PA.Colors.border, lineWidth: 2)
                        .frame(width: 22, height: 22)
                    if isSelected {
                        Circle()
                            .fill(PA.Colors.accent)
                            .frame(width: 12, height: 12)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(planTitle(productID: productID))
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                        if let badge {
                            Text(badge)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(PA.Colors.gold)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(PA.Colors.gold.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                    Text(planSubtitle(product: product, productID: productID))
                        .font(.system(size: 12))
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                Spacer(minLength: 0)
                Text(planPrice(product: product, productID: productID))
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(isSelected ? PA.Colors.accentSoft : PA.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isSelected ? PA.Colors.accent : PA.Colors.border, lineWidth: isSelected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func planTitle(productID: String) -> String {
        switch productID {
        case PremiumProducts.proYearly:  return "Yearly"
        case PremiumProducts.proMonthly: return "Monthly"
        default: return "Pro"
        }
    }

    private func planSubtitle(product: Product?, productID: String) -> String {
        // Trial path takes priority — the free week is the lead message.
        // Both .eligible and .unknown render the same subtitle so the
        // value framing is consistent; the CTA + supporting line carry
        // the eligibility nuance.
        if showsTrialCopy(forProductID: productID) {
            let priced = planPrice(product: product, productID: productID)
            return "7 days free, then \(priced)"
        }
        // Yearly without trial: show monthly equivalent so the annual
        // value is obvious at a glance.
        if productID == PremiumProducts.proYearly,
           let perMonth = yearlyPerMonthPrice(product: product) {
            return "\(perMonth)/mo · billed yearly"
        }
        guard let product else {
            return productID == PremiumProducts.proYearly ? "Billed yearly" : "Billed monthly"
        }
        let period = product.subscription?.subscriptionPeriod
        switch period?.unit {
        case .year:  return "Billed once a year"
        case .month: return "Billed monthly"
        case .week:  return "Billed weekly"
        case .day:   return "Billed daily"
        default:     return "Auto-renews until canceled"
        }
    }

    private func planPrice(product: Product?, productID: String) -> String {
        guard let product else { return "—" }
        let suffix: String
        switch productID {
        case PremiumProducts.proYearly:  suffix = "/year"
        case PremiumProducts.proMonthly: suffix = "/mo"
        default:                          suffix = ""
        }
        return "\(product.displayPrice)\(suffix)"
    }

    /// Yearly price ÷ 12, formatted in the product's currency. Used in
    /// the yearly plan subtitle ("$7.50/mo · billed yearly"). Returns
    /// nil when the product hasn't loaded yet.
    private func yearlyPerMonthPrice(product: Product?) -> String? {
        guard let product else { return nil }
        let perMonth = product.price / Decimal(12)
        return perMonth.formatted(product.priceFormatStyle)
    }

    // MARK: - Disclosure + CTA
    //
    // Split into two lines so the friendly summary reads as a human
    // commit ("Free for 7 days, then $X. Cancel anytime.") and the
    // legal auto-renew language sits underneath in smaller, lower-
    // priority type — App Store compliant without overwhelming the
    // visual hierarchy.

    private var purchaseDisclosure: some View {
        let copy = disclosureCopy
        return VStack(spacing: 4) {
            Text(copy.friendly)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(PA.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(copy.legal)
                .font(.system(size: 10))
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 8)
    }

    private struct DisclosureCopy {
        let friendly: String
        let legal: String
    }

    private var disclosureCopy: DisclosureCopy {
        let legal = "Subscription auto-renews until canceled. Cancel at least 24 hours before renewal in App Store settings."
        switch selectedTrialState {
        case .eligible:
            let priced = planPrice(product: store.products[selectedProductID], productID: selectedProductID)
            return DisclosureCopy(
                friendly: "Free for 7 days, then \(priced). Cancel anytime.",
                legal: legal,
            )
        case .unknown:
            let priced = planPrice(product: store.products[selectedProductID], productID: selectedProductID)
            return DisclosureCopy(
                friendly: "Available for eligible new subscribers. Then \(priced). Cancel anytime.",
                legal: legal,
            )
        case .noTrial:
            return DisclosureCopy(
                friendly: "Cancel anytime. No commitment.",
                legal: legal,
            )
        }
    }

    /// Tight grouping of the primary action + Restore Purchases.
    /// Putting Restore directly under the CTA makes it discoverable
    /// without scrolling — App Store users expect it near the action,
    /// and burying it in the footer reads as evasive.
    private var purchaseActions: some View {
        VStack(spacing: 12) {
            subscribeCTA
            restoreButton
        }
    }

    private var subscribeCTA: some View {
        Button {
            Task { await subscribeTapped() }
        } label: {
            ZStack {
                if isPurchasing {
                    ProgressView()
                        .tint(.black)
                } else {
                    Text(ctaText)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.black)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(PA.Colors.accent)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isPurchasing || store.products[selectedProductID] == nil)
    }

    private var restoreButton: some View {
        Button {
            Task { await restoreTapped() }
        } label: {
            Text("Restore Purchases")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
        }
        .buttonStyle(.plain)
        .disabled(isPurchasing)
    }

    private var ctaText: String {
        switch selectedTrialState {
        case .eligible: return "Start 7-day free trial"
        case .unknown:  return "Try 7 days free"
        case .noTrial:  return "Start Pro"
        }
    }

    @ViewBuilder
    private var statusMessages: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.negative)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        if let pendingMessage {
            Text(pendingMessage)
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.gold)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Footer links

    private var footerLinks: some View {
        // Restore Purchases moved up next to the CTA (see
        // `purchaseActions`); the footer is now just legal/management
        // links so it doesn't compete with the action area.
        HStack(spacing: 18) {
            footerLink("Terms", url: "https://popalpha.ai/terms")
            footerLink("Privacy", url: "https://popalpha.ai/privacy")
            footerLink("Manage", url: "https://apps.apple.com/account/subscriptions")
        }
        .padding(.top, 4)
    }

    private func footerLink(_ title: String, url: String) -> some View {
        Group {
            if let parsed = URL(string: url) {
                Link(title, destination: parsed)
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted)
            } else {
                Text(title)
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    // MARK: - Actions

    private func subscribeTapped() async {
        guard let product = store.products[selectedProductID] else { return }
        errorMessage = nil
        pendingMessage = nil
        isPurchasing = true
        defer { isPurchasing = false }

        do {
            let outcome = try await store.purchase(product)
            switch outcome {
            case .success:
                // Dismiss explicitly so the paywall closes immediately
                // after the system purchase sheet does. The onChange
                // handler on gate.isPro is a safety net (covers the
                // restore path), but real-device tests showed the
                // observation chain (StoreKit → Transaction.finish →
                // refreshStatus → @Published store.status → Combine
                // sink → gate.isPro → onChange → dismiss) sometimes
                // races with view re-render and the user briefly sees
                // the paywall again. Calling dismiss directly removes
                // that gap.
                dismiss()
            case .userCancelled:
                break
            case .pending:
                pendingMessage = "Purchase is pending — usually a parental approval. We'll unlock automatically once it goes through."
            }
        } catch {
            errorMessage = "Couldn't complete purchase: \(error.localizedDescription)"
        }
    }

    private func restoreTapped() async {
        errorMessage = nil
        pendingMessage = nil
        await store.restorePurchases()
        if let storeError = store.lastError {
            errorMessage = storeError
        } else if !gate.isPro {
            errorMessage = "No active subscription found for this Apple ID."
        } else {
            // Same rationale as the purchase success path: dismiss
            // explicitly rather than waiting for the gate.isPro
            // onChange observer to fire.
            dismiss()
        }
    }
}

#if DEBUG
#Preview {
    PaywallView()
}
#endif
