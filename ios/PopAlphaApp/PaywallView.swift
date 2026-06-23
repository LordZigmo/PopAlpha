// PaywallView.swift
//
// Auto-renewable subscription paywall. Presented as a sheet from
// optional Pro entry points such as the scanner crown tap and the
// Settings → Upgrade Plan row.
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
/// presented from the scanner can lead with market intelligence, etc. All
/// existing call sites pass `.generic` (the default) — the contextual
/// branches are wiring for future variant tests.
public enum PaywallContext: String {
    case generic
    case scanner
    case collectorProfile
    /// Auto-presented at app launch for users who previously had a
    /// trial (or paid sub) and have lapsed back to free. Higher-
    /// conversion cohort than fresh free users — they've already
    /// experienced Pro features, so the hero leads with "welcome
    /// back" rather than introducing the value.
    case reengagement
    /// Auto-presented to a user whose free trial expires within 48h.
    /// Highest-leverage trial→paid surface: paired with a
    /// server-driven push notification 24h before expiry, this is
    /// the in-app catch when the user opens the app to convert.
    case trialExpiring
}

struct PaywallView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = PremiumStore.shared
    @StateObject private var gate = PremiumGate.shared

    var context: PaywallContext = .generic
    /// Specific entry point that opened the paywall. Used as a
    /// PostHog `surface` property on every paywall_* event so the
    /// funnel can be sliced per-source. Default "unknown" so an
    /// un-instrumented call site is loud in dashboards rather than
    /// silently masquerading as a known surface.
    var surface: String = "unknown"

    /// Optional, call-site-supplied personalization so the hero can speak to the
    /// user's own data (their card, their portfolio) instead of generic copy —
    /// the single biggest paywall conversion lever. All fields optional; the
    /// hero falls back to the ROI/context copy when absent.
    struct Personalization {
        var cardName: String? = nil
        var cardChangePct: Double? = nil
        var portfolioValue: Double? = nil
        var portfolioCardCount: Int? = nil
        /// Canonical slug of the tapped card — lets the collector-insight
        /// surface fetch a real deterministic teaser of THIS card's read.
        var canonicalSlug: String? = nil
    }
    var personalization = Personalization()

    @State private var selectedProductID: String = PremiumProducts.proYearly
    /// Drives the trial-start celebration overlay before the paywall
    /// auto-dismisses on a successful subscribe.
    @State private var showTrialSuccess = false
    /// Deterministic Collector Insight teaser for the tapped card. nil until
    /// fetched, and while the server still Pro-gates free users (the fetch
    /// returns nil there → the teaser shows its honest blurred fallback).
    @State private var teaserInsight: CollectorInsight?
    @State private var teaserDidLoad = false
    @State private var isPurchasing: Bool = false
    @State private var errorMessage: String? = nil
    @State private var pendingMessage: String? = nil
    /// Set once when the user successfully subscribes or restores so
    /// .onDisappear can distinguish "user dismissed" from "sheet
    /// closed because they upgraded." Without this we'd over-count
    /// dismissals.
    @State private var didCompletePurchase: Bool = false
    /// Once-per-presentation guard for the paywall_viewed event so
    /// the count reflects sheet presentations, not view re-renders.
    @State private var didFireViewedEvent: Bool = false
    // Per-product intro-offer eligibility, keyed by product ID. Empty
    // until `.task` resolves; lookup falls back to "true" (optimistic)
    // so the trial copy renders during the brief async window for
    // first-time users (the common case). Updated for every product
    // that carries a subscription.
    @State private var eligibilityByProductID: [String: Bool] = [:]

    // MARK: - Sign-in gate
    //
    // Apple subscriptions must attach to a PopAlpha account: /api/iap/verify
    // requires an authenticated user, so a guest purchase 401s and is never
    // recorded server-side (the user ends up Pro on-device but invisible to
    // hasPro() checks). We therefore require sign-in BEFORE handing off to
    // StoreKit. `pendingPurchaseAfterSignIn` remembers the user was mid-
    // subscribe so the purchase auto-resumes the instant auth lands (see the
    // isAuthenticated onChange) — the gate feels like one continuous flow
    // rather than "sign in, then tap Subscribe again."
    @State private var showSignInForPurchase = false
    @State private var pendingPurchaseAfterSignIn = false

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
                    if showsCollectorTeaser {
                        collectorInsightTeaser
                    }
                    benefits
                    if store.productsLoaded && store.products.isEmpty {
                        plansRetryBanner
                    } else {
                        plans
                    }
                    purchaseDisclosure
                    purchaseActions
                    statusMessages
                    footerLinks
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 20)
            }

            if showTrialSuccess {
                trialSuccessOverlay
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
        .task(id: personalization.canonicalSlug) {
            await loadTeaserInsight()
        }
        .onChange(of: gate.isPro) { _, isProNow in
            // Auto-dismiss the moment the user becomes pro — but NOT while the
            // trial-start celebration is playing (the subscribe path drives its
            // own animated dismiss). This still covers the restore path.
            if isProNow && !showTrialSuccess { dismiss() }
        }
        .onAppear {
            guard !didFireViewedEvent else { return }
            didFireViewedEvent = true
            AnalyticsService.shared.capture(.paywallViewed, properties: paywallEventProps)
        }
        .onDisappear {
            // Distinguish dismissal from purchase-success-auto-close.
            // didCompletePurchase is set in subscribeTapped/restoreTapped
            // BEFORE this fires, so we only capture dismissed when the
            // user actually closed without buying / restoring.
            guard !didCompletePurchase else { return }
            AnalyticsService.shared.capture(.paywallDismissed, properties: paywallEventProps)
        }
        // Sign-in required before purchase (guest-purchase gate). Presented
        // locally — NOT via AuthService.signIn()'s global sheet — so it stacks
        // ABOVE the paywall instead of appearing behind it.
        .sheet(isPresented: $showSignInForPurchase, onDismiss: onSignInForPurchaseDismissed) {
            SignInSheet(startingPhase: .chooser)
        }
        .onChange(of: AuthService.shared.isAuthenticated) { _, isAuthedNow in
            // Auth landed while a purchase was waiting on it → resume the exact
            // purchase the user tapped. Guarded by the pending flag so an
            // unrelated sign-in (e.g. a cold-launch session restore) can never
            // trigger a surprise StoreKit sheet.
            guard isAuthedNow, pendingPurchaseAfterSignIn else { return }
            pendingPurchaseAfterSignIn = false
            showSignInForPurchase = false
            guard let product = store.products[selectedProductID] else { return }
            let isTrialOffer = showsTrialCopy(forProductID: selectedProductID)
            Task { await performPurchase(product: product, isTrialOffer: isTrialOffer) }
        }
    }

    /// Common properties carried on every paywall_* PostHog event.
    /// Each call site adds purchase-specific dims (product_id,
    /// was_trial, etc.) on top.
    private var paywallEventProps: [String: Any] {
        [
            "context": context.rawValue,
            "surface": surface,
        ]
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

    /// Prominent value prop. Personalized to the user's own data when the call
    /// site supplies it (their card / their portfolio); otherwise leads with the
    /// ROI hook — for a money-decision app, "Pro pays for itself" is the
    /// strongest universal frame.
    private var heroHeadline: String {
        // Collector-insight surface (a specific card): continue the read the
        // user tapped, framed around fit/identity — never price. (Gated on a
        // card name so the portfolio-radar surface, which also uses
        // .collectorProfile but supplies portfolioValue, keeps its own copy.)
        if context == .collectorProfile, let card = personalization.cardName {
            return "See how \(card) fits your collection."
        }
        if let value = personalization.portfolioValue, value > 0 {
            return "Your collection is worth \(value.formatted(.currency(code: "USD").precision(.fractionLength(0))))."
        }
        if let card = personalization.cardName {
            if let chg = personalization.cardChangePct, abs(chg) >= 1 {
                let arrow = chg >= 0 ? "up" : "down"
                return "\(card) is \(arrow) \(Int(abs(chg).rounded()))% — know what's next."
            }
            return "Know what \(card) is really worth."
        }
        switch context {
        case .reengagement:  return "Welcome back."
        case .trialExpiring: return "Your free trial ends soon."
        case .generic, .scanner, .collectorProfile:
            return "Don't overpay. Don't sell low."
        }
    }

    /// Smaller supporting line. When personalized, it carries the ROI + the
    /// mechanism; otherwise it's the per-context detail.
    private var heroSubheadline: String {
        // Collector-insight surface: lead with the free-scanning reassurance —
        // it kills the "wait, are scans paywalled?" objection right at the
        // decision — then the intelligence frame (not price/ROI).
        if context == .collectorProfile, personalization.cardName != nil {
            return "Scanning stays unlimited and free. Pro unlocks the intelligence behind every card."
        }
        if personalization.portfolioValue != nil || personalization.cardName != nil {
            return "One better buy or sell pays for a year of Pro — with unlimited AI analysis, market signals, and price alerts."
        }
        switch context {
        case .generic:
            return "One better buy or sell pays for a year of Pro — unlimited AI analysis, signals, and alerts built around your collection."
        case .scanner:
            return "Scanning is free. Pro gives every card you scan unlimited AI analysis and alerts so you catch the next move."
        case .collectorProfile:
            return "See your collection style, radar chart, and AI insights tuned to the cards you own."
        case .reengagement:
            return "Pick up where you left off — your Pro features are one tap away."
        case .trialExpiring:
            return "Subscribe today to keep your collector profile, market signals, and price alerts."
        }
    }

    // MARK: - Collector Insight teaser
    //
    // Leads the collector-insight paywall with the thing the user tapped: a
    // partial read of THIS card. When the server returns a real deterministic
    // read, the fit badge + lead line are real and only the depth blurs. Until
    // the server free-preview ships (the route Pro-gates free users today, so
    // the fetch returns nil), it degrades to an honest invitation + blurred
    // structure — never a fabricated score.

    private var showsCollectorTeaser: Bool {
        context == .collectorProfile && personalization.cardName != nil
    }

    private func loadTeaserInsight() async {
        guard showsCollectorTeaser, let slug = personalization.canonicalSlug, !teaserDidLoad else { return }
        teaserDidLoad = true
        let resp = await PersonalizationService.shared.fetchExplanation(slug: slug, variantRef: nil)
        teaserInsight = resp?.collectorInsight
    }

    private static let teaserAccent = Color(red: 0.659, green: 0.333, blue: 0.969)

    private var teaserLeadLine: String {
        if let summary = teaserInsight?.summary, !summary.isEmpty {
            // First sentence reads; the rest blurs below.
            if let end = summary.firstIndex(of: ".") {
                return String(summary[...end])
            }
            return summary
        }
        let card = personalization.cardName ?? "this card"
        return "See how \(card) fits your collecting style — your full read is one tap away."
    }

    @ViewBuilder
    private func teaserFitBadge() -> some View {
        let text: String = {
            if let label = teaserInsight?.fitLabel, !label.isEmpty {
                return teaserInsight?.fitScore.map { "\(label) · \($0)/100" } ?? label
            }
            return "PRO"
        }()
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Self.teaserAccent)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Self.teaserAccent.opacity(0.16))
            .clipShape(Capsule())
    }

    private func teaserBlurRow(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Self.teaserAccent.opacity(0.85))
            Text("This part of your read is reserved for Pro — it unlocks the moment you start.")
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var collectorInsightTeaser: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Self.teaserAccent)
                Text("COLLECTOR INSIGHT")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.2)
                    .foregroundStyle(Self.teaserAccent)
                Spacer()
                teaserFitBadge()
            }
            Text(teaserLeadLine)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PA.Colors.text)
                .fixedSize(horizontal: false, vertical: true)
            ZStack {
                VStack(alignment: .leading, spacing: 10) {
                    teaserBlurRow("Role in your collection")
                    teaserBlurRow("Best move")
                }
                .blur(radius: 5)
                .accessibilityHidden(true)
                HStack(spacing: 5) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                    Text("Unlock the full read")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(Self.teaserAccent)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.teaserAccent.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Self.teaserAccent.opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Trial-start celebration

    /// Cue under the checkmark — names the card when we have it.
    private var successSubtitle: String {
        if context == .collectorProfile, let card = personalization.cardName {
            return "Unlocking your read on \(card)…"
        }
        return "Unlocking your Collector Insights…"
    }

    /// Brief celebratory beat the instant a subscribe succeeds, before the
    /// paywall dismisses — rewards the commit and signals the read is loading.
    @ViewBuilder
    private var trialSuccessOverlay: some View {
        ZStack {
            PA.Colors.background.opacity(0.97).ignoresSafeArea()
            VStack(spacing: 18) {
                ZStack {
                    Circle()
                        .fill(PA.Colors.accentSoft)
                        .frame(width: 116, height: 116)
                        .scaleEffect(showTrialSuccess ? 1 : 0.3)
                    ForEach(0..<6, id: \.self) { i in
                        Image(systemName: "sparkle")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(PA.Colors.gold)
                            .offset(y: -66)
                            .rotationEffect(.degrees(Double(i) / 6 * 360))
                            .scaleEffect(showTrialSuccess ? 1 : 0.1)
                            .opacity(showTrialSuccess ? 1 : 0)
                    }
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 68, weight: .bold))
                        .foregroundStyle(PA.Colors.accent)
                        .scaleEffect(showTrialSuccess ? 1 : 0.2)
                        .rotationEffect(.degrees(showTrialSuccess ? 0 : -25))
                }
                Text("You're in.")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                Text(successSubtitle)
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(40)
        }
        .transition(.opacity)
    }

    // MARK: - Benefits

    /// Shown when StoreKit finished loading but returned no products — a
    /// graceful "Retry" instead of blank price rows. (The usual root cause
    /// pre-launch is the subscriptions not yet being live in App Store
    /// Connect; Retry recovers a transient network failure.)
    private var plansRetryBanner: some View {
        VStack(spacing: 8) {
            Text("Couldn't load plans")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Check your connection and try again.")
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.textSecondary)
            Button {
                Task { await store.loadProducts() }
            } label: {
                Text("Retry")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .background(PA.Colors.accentSoft)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }

    private var benefits: some View {
        // Reinforcement below the decision — what Pro unlocks, framed as
        // understanding/identity (not data/price). Leads with the most
        // differentiated value.
        VStack(spacing: 8) {
            benefitRow(
                icon: "person.crop.square.filled.and.at.rectangle",
                title: "Collector Insights",
                subtitle: "Whether a card is you — how it fits your style, your gaps, and your next move."
            )
            benefitRow(
                icon: "sparkles",
                title: "AI Market Briefs",
                subtitle: "Why a card's moving, in plain English — the story behind the number."
            )
            benefitRow(
                icon: "chart.line.uptrend.xyaxis",
                title: "Collection Signals",
                subtitle: "What's quietly gaining steam across the sets you actually collect."
            )
            benefitRow(
                icon: "bell.badge",
                title: "Opportunity Alerts",
                subtitle: "A nudge the moment a card you're watching hits one worth acting on."
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
            return yearlySavingsBadge
        }
        return nil
    }

    /// Real savings of yearly vs 12× monthly, computed from live StoreKit prices
    /// so the badge can't drift from actual pricing (a misleading-price App
    /// Review risk). Falls back to a sensible default before products load.
    private var yearlySavingsBadge: String? {
        guard let yearly = store.products[PremiumProducts.proYearly]?.price,
              let monthly = store.products[PremiumProducts.proMonthly]?.price else {
            return "Save 37%"
        }
        let yearlyUSD = NSDecimalNumber(decimal: yearly).doubleValue
        let annualizedMonthly = NSDecimalNumber(decimal: monthly).doubleValue * 12
        guard annualizedMonthly > yearlyUSD, yearlyUSD > 0 else { return nil }
        let pct = Int(((annualizedMonthly - yearlyUSD) / annualizedMonthly * 100).rounded())
        return pct >= 1 ? "Save \(pct)%" : nil
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
                friendly: "Free for 7 days — we'll remind you before it ends. Then \(priced). Cancel anytime.",
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
        // Collector-insight surface: remind them exactly what the tap delivers.
        if context == .collectorProfile, personalization.cardName != nil {
            switch selectedTrialState {
            case .eligible, .unknown: return "Start Free Trial — See My Read"
            case .noTrial:            return "Unlock My Read"
            }
        }
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

        // Whether the user is tapping a trial-flavored CTA ("Start
        // 7-day free trial" / "Try 7 days free"). Both .eligible and
        // .unknown surface trial copy; only .noTrial is "Start Pro".
        let isTrialOffer = showsTrialCopy(forProductID: selectedProductID)

        // Top-of-tap analytics — fires regardless of outcome so the
        // funnel can compare "tapped Subscribe" → "Subscribed" /
        // "Cancelled" / "Failed".
        var tapProps = paywallEventProps
        tapProps["product_id"] = selectedProductID
        tapProps["is_trial_offer"] = isTrialOffer
        AnalyticsService.shared.capture(.paywallSubscribeTapped, properties: tapProps)

        // Guest-purchase gate. A subscription can only be recorded server-side
        // against a signed-in user (/api/iap/verify requires auth); letting a
        // guest pay leaves them Pro on-device but invisible to the server — the
        // exact failure this PR fixes. Require sign-in first; the purchase
        // resumes automatically once auth lands (isAuthenticated onChange).
        guard AuthService.shared.isAuthenticated else {
            var gateProps = paywallEventProps
            gateProps["product_id"] = selectedProductID
            AnalyticsService.shared.capture(.paywallSignInRequired, properties: gateProps)
            pendingPurchaseAfterSignIn = true
            showSignInForPurchase = true
            return
        }

        await performPurchase(product: product, isTrialOffer: isTrialOffer)
    }

    /// Runs the StoreKit purchase + post-purchase analytics. Split out of
    /// `subscribeTapped` so the sign-in gate can re-enter it directly once auth
    /// lands WITHOUT re-firing the subscribe-tapped funnel event.
    private func performPurchase(product: Product, isTrialOffer: Bool) async {
        errorMessage = nil
        pendingMessage = nil
        isPurchasing = true
        defer { isPurchasing = false }

        do {
            let outcome = try await store.purchase(product)
            switch outcome {
            case .success(let serverVerified):
                didCompletePurchase = true
                var subscribedProps = paywallEventProps
                subscribedProps["product_id"] = selectedProductID
                subscribedProps["was_trial"] = isTrialOffer
                subscribedProps["display_price"] = product.displayPrice
                subscribedProps["server_verified"] = (serverVerified == .verified)
                AnalyticsService.shared.capture(.paywallSubscribed, properties: subscribedProps)

                // Local StoreKit entitlement is authoritative for UI, but if
                // the server didn't record it the user gets no server-side Pro
                // and the funnel loses subscription_verified_server. Make that
                // discrepancy LOUD instead of swallowing it — the silent
                // version is precisely the bug being fixed.
                if serverVerified != .verified {
                    var verifyFailProps = paywallEventProps
                    verifyFailProps["product_id"] = selectedProductID
                    verifyFailProps["reason"] = serverVerified.telemetryReason
                    AnalyticsService.shared.capture(.subscriptionVerifyFailedClient, properties: verifyFailProps)
                }

                // Celebrate the commit before closing — a brief beat that
                // rewards the decision and cues the read is unlocking. The
                // gate.isPro onChange is gated off while this plays so the two
                // dismiss paths don't race (real-device note from the prior fix).
                PAHaptics.tap()
                withAnimation(.spring(response: 0.55, dampingFraction: 0.7)) {
                    showTrialSuccess = true
                }
                try? await Task.sleep(nanoseconds: 1_600_000_000)
                dismiss()
            case .userCancelled:
                var failProps = paywallEventProps
                failProps["product_id"] = selectedProductID
                failProps["reason"] = "user_cancelled"
                AnalyticsService.shared.capture(.paywallPurchaseFailed, properties: failProps)
            case .pending:
                pendingMessage = "Purchase is pending — usually a parental approval. We'll unlock automatically once it goes through."
                var failProps = paywallEventProps
                failProps["product_id"] = selectedProductID
                failProps["reason"] = "pending"
                AnalyticsService.shared.capture(.paywallPurchaseFailed, properties: failProps)
            }
        } catch {
            errorMessage = "Couldn't complete purchase: \(error.localizedDescription)"
            var failProps = paywallEventProps
            failProps["product_id"] = selectedProductID
            failProps["reason"] = "error"
            failProps["error"] = error.localizedDescription
            AnalyticsService.shared.capture(.paywallPurchaseFailed, properties: failProps)
        }
    }

    /// Sign-in sheet closed. If the user authenticated, the isAuthenticated
    /// onChange already resumed the purchase. If they backed out (still not
    /// authed and not mid-OAuth), drop the pending intent so a later unrelated
    /// sign-in can't trigger a surprise purchase, and record the abandonment.
    private func onSignInForPurchaseDismissed() {
        guard pendingPurchaseAfterSignIn else { return }
        // Choosing an OAuth provider (Google/Apple) dismisses this sheet
        // synchronously while AuthService sets `isSigningIn` inside a spawned
        // Task — so at dismiss time BOTH isAuthenticated and isSigningIn can
        // still be false even though OAuth is about to start. Deciding
        // abandonment now would race that Task: we'd clear the pending intent
        // and the later auth flip wouldn't resume the purchase. Defer a beat so
        // the terminal state has settled, then abandon ONLY if it's a real
        // cancel: not authed (else onChange resumed it), not mid-OAuth, and the
        // sheet wasn't re-presented by a second Subscribe tap.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard pendingPurchaseAfterSignIn,
                  !showSignInForPurchase,
                  !AuthService.shared.isAuthenticated,
                  !AuthService.shared.isSigningIn else { return }
            pendingPurchaseAfterSignIn = false
            var cancelProps = paywallEventProps
            cancelProps["product_id"] = selectedProductID
            cancelProps["reason"] = "signin_abandoned"
            AnalyticsService.shared.capture(.paywallPurchaseFailed, properties: cancelProps)
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
            didCompletePurchase = true
            AnalyticsService.shared.capture(.paywallRestoreSucceeded, properties: paywallEventProps)
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
