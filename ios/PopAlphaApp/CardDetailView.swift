import SwiftUI
import NukeUI

private let abundantRawCardMaxUsd: Double = 2
private let abundantRawCardHeroLabel = "Abundant"
private let abundantRawCardDetailLabel = "Usually under $2 - pay what feels fair"

// MARK: - Price Mode

enum PriceMode: Equatable, Hashable {
    case nearMint
    case graded(provider: String, bucket: String)

    var isGraded: Bool {
        if case .graded = self { return true }
        return false
    }

    var label: String {
        switch self {
        case .nearMint: return "Near Mint"
        case .graded(let provider, let bucket):
            let bucketLabel: String = {
                switch bucket {
                case "LE_7": return "≤7"
                case "G8": return "8"
                case "G9": return "9"
                case "G9_5": return "9.5"
                case "G10": return "10"
                case "G10_PERFECT": return "10 Perfect"
                default: return bucket
                }
            }()
            return "\(provider) \(bucketLabel)"
        }
    }
}

func selectNearMintHeroPrice(
    isJapaneseCard: Bool,
    marketPrice: Double?,
    activeCardPrice: Double,
    chartFallbackPrice: Double?,
    yahooJpPrice: Double?,
    yahooJpSampleCount: Int?,
    snkrdunkPrice: Double?,
    snkrdunkSampleCount: Int?
) -> Double? {
    if isJapaneseCard {
        let pick = selectJpPriceSource(
            yahooJpPrice: yahooJpPrice,
            yahooJpSampleCount: yahooJpSampleCount,
            snkrdunkPrice: snkrdunkPrice,
            snkrdunkSampleCount: snkrdunkSampleCount
        )
        if let price = pick.price, price > 0 {
            return price
        }
    }
    if let marketPrice, marketPrice > 0 { return marketPrice }
    if activeCardPrice > 0 { return activeCardPrice }
    if let chartFallbackPrice, chartFallbackPrice > 0 { return chartFallbackPrice }
    return nil
}

struct CardDetailView: View {
    /// The card the user navigated to. Used as the initial value for
    /// `activeCard`; subsequent EN/JP toggling mutates `activeCard`
    /// while this field stays put for diagnostics / scan-correction
    /// flows that need the original slug. Not read directly from the
    /// body — go through `activeCard`.
    let card: MarketCard
    /// sha256 of the scan image that brought the user to this detail view,
    /// if any. Set only when navigating from the scanner. When non-nil, a
    /// "Not this card?" correction affordance appears in the hero section
    /// so the user can hand the identifier a ground-truth label without
    /// re-photographing the card. Defaults nil so existing call sites
    /// (portfolio, signals, marketplace, set detail) don't need updates.
    let scanImageHash: String?
    /// Source UIImage retained for offline scans only — needed because
    /// no scan-uploads/<hash>.jpg exists on the server, so the
    /// correction-promote flow must re-upload bytes via the multipart
    /// variant. Nil for online scans (server already has the file).
    let scanImage: UIImage?
    let scanCorrectionMetadata: ScanCorrectionPredictedMetadata?

    /// The card whose data the view is currently rendering. Mutates
    /// when the user taps the EN/JP toggle: we synthesize a stub
    /// MarketCard from the paired slug and let the .task(id:) chain
    /// re-fire to repopulate cardProfile/cardMetrics/printings/etc.
    /// The hero accent flips immediately because the `isJapaneseCard`
    /// cascade reads `activeCard.id.hasSuffix("-jp")` before any
    /// network round-trip completes.
    @State private var activeCard: MarketCard

    init(
        card: MarketCard,
        scanImageHash: String? = nil,
        scanImage: UIImage? = nil,
        scanCorrectionMetadata: ScanCorrectionPredictedMetadata? = nil
    ) {
        self.card = card
        self._activeCard = State(initialValue: card)
        self.scanImageHash = scanImageHash
        self.scanImage = scanImage
        self.scanCorrectionMetadata = scanCorrectionMetadata
    }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var premiumGate = PremiumGate.shared
    @State private var showCorrectionSheet = false
    @State private var showMarketSummaryPaywall = false
    /// Tracks the "sign in then auto-save this card" flow. Set when an
    /// unauthenticated user taps the + FAB; cleared on completion or
    /// cancel. Watched by an .onChange so when isAuthenticated flips
    /// true while pending, we save the card without making the user
    /// re-tap anything.
    @State private var pendingAddAfterSignIn = false
    @State private var showSignInPromptForAdd = false
    /// Brief success banner shown after the auto-save lands. Non-modal
    /// so the user immediately sees they're back on the same card.
    @State private var showAddedBanner = false
    @State private var autoAddError: String?
    @State private var selectedTimeframe: ChartTimeframe = .week
    @State private var chartPrices: [Double] = []
    @State private var chartTimestamps: [String] = []
    @State private var chartLoading = false
    @State private var chartError: String?
    @State private var cardProfile: CardProfileResult?
    @State private var cardMetrics: CardMetricsResult?
    @State private var friendActivity: ActivityService.CardActivityResponse?
    @State private var showAddHolding = false
    @State private var selectedPriceMode: PriceMode = .nearMint
    @State private var availableGradedOptions: [PriceMode] = []
    @State private var gradedMetricsLoaded = false
    @State private var gradedHeroPrice: Double?
    @State private var selectedGradingAgency: String = "PSA"
    @State private var selectedGradeBucket: String = "G10"
    @State private var availablePrintings: [CardPrintingOption] = []
    @State private var selectedPrintingId: String?
    @State private var printingHeroPrice: Double?
    @State private var conditionPrices: [ConditionPriceRow] = []
    /// Per-grade-bucket aggregate market summary, keyed by grade bucket
    /// (LE_7, G8, G9, G9_5, G10, G10_PERFECT). Sourced from card_metrics
    /// which is keyed (slug, printing_id, grade) — no provider dimension.
    @State private var gradedCardMetricsByBucket: [String: GradedCardMetricRow] = [:]
    /// Slug of the cross-language partner card (EN <-> JP). Nil when no
    /// pairing exists in card_translations, or before the
    /// /api/cards/[slug]/detail fetch lands. Populated by .task on each
    /// activeCard.id change. When non-nil, the EN/JP toggle renders in
    /// pricingSection and tapping it swaps activeCard to the paired slug.
    @State private var pairedSlug: String? = nil
    @State private var pairedLanguage: CardLanguage? = nil
    /// Mirrored (or raw fallback) image URL for the paired card,
    /// fetched alongside pairedSlug. Lets swapToPairedLanguage build a
    /// stub MarketCard with the paired card's art available
    /// immediately, so the hero swaps directly EN ↔ JP rather than
    /// falling back to heroPlaceholder during the metrics round-trip.
    @State private var pairedImageUrl: String? = nil
    /// True for the brief window between the user tapping the toggle and
    /// cardMetrics arriving for the new slug. Fades the hero block to
    /// 60% so the transition reads as deliberate, not janky.
    @State private var togglingLanguage = false

    @State private var spinAngle: Double = 0
    @State private var spinDragStart: Double = 0
    /// Per-drag classification. Once a drag is .rejected (scroll-bound)
    /// it stays rejected for the rest of the gesture, so a drag that
    /// starts vertical and drifts horizontal can never retroactively
    /// engage the spinner mid-flight.
    private enum SpinDragState { case undecided, engaged, rejected }
    @State private var spinDragState: SpinDragState = .undecided

    // MARK: - JP card theming

    /// Whether to render this detail view in the JP red-tone theme.
    /// Detection cascades:
    ///   1. cardMetrics.language == "JP" — authoritative once fetched.
    ///   2. activeCard.id ends in "-jp" — the JP slug suffix convention from
    ///      the Scrydex importer; covers the brief window between
    ///      navigation and the metrics fetch landing.
    ///   3. cardMetrics has populated yahoo_jp_price OR snkrdunk_price —
    ///      final fallback for any JP card that somehow slipped past
    ///      the above (both are JP-native sold-price sources).
    private var isJapaneseCard: Bool {
        if cardMetrics?.language == "JP" { return true }
        if activeCard.id.hasSuffix("-jp") { return true }
        if cardMetrics?.yahooJpPrice != nil { return true }
        if cardMetrics?.snkrdunkPrice != nil { return true }
        return false
    }

    /// Accent color for JP cards. PA.AxisColors.marketHeat is the
    /// project's "hot red" (#EF4444) from the collector-axis palette —
    /// distinct from PA.Colors.negative (used for negative price
    /// changes) so the theming doesn't double-meaning with sell
    /// signals. Lives at PA.AxisColors (sibling of PA.Colors, not
    /// nested) because it was originally defined for the taste-radar
    /// "Market Heat" axis; reusing it here keeps a single color source
    /// of truth instead of inventing a new red.
    private var detailAccent: Color {
        isJapaneseCard ? PA.AxisColors.marketHeat : PA.Colors.accent
    }

    /// JP cards prefer JP-native sold prices over the Scrydex-derived
    /// US/global price. Confidence-pick between Yahoo! Auctions JP and
    /// Snkrdunk when both are present — the one with more sample sales
    /// wins (its median is more stable). Scrydex stays as fallback
    /// when neither JP scraper has data — at which point the EN price
    /// is the only signal we have, even if it's a US-market price for
    /// a Japanese card.
    private var preferredHeroPrice: Double? {
        selectNearMintHeroPrice(
            isJapaneseCard: isJapaneseCard,
            marketPrice: cardMetrics?.marketPrice,
            activeCardPrice: cardMetrics == nil ? activeCard.price : 0,
            chartFallbackPrice: printingHeroPrice,
            yahooJpPrice: cardMetrics?.yahooJpPrice,
            yahooJpSampleCount: cardMetrics?.yahooJpSampleCount,
            snkrdunkPrice: cardMetrics?.snkrdunkPrice,
            snkrdunkSampleCount: cardMetrics?.snkrdunkSampleCount
        )
    }

    private var isAbundantNearMintHeroPrice: Bool {
        guard !selectedPriceMode.isGraded, let price = preferredHeroPrice else { return false }
        return price > 0 && price <= abundantRawCardMaxUsd
    }

    /// Source label shown next to the hero price so the user knows
    /// which provider the number came from. Matches the confidence-pick
    /// winner from preferredHeroPrice. Affects only the inline hint,
    /// not the top-level pricing structure.
    private var heroPriceSourceLabel: String? {
        if isJapaneseCard {
            let pick = selectJpPriceSource(
                yahooJpPrice: cardMetrics?.yahooJpPrice,
                yahooJpSampleCount: cardMetrics?.yahooJpSampleCount,
                snkrdunkPrice: cardMetrics?.snkrdunkPrice,
                snkrdunkSampleCount: cardMetrics?.snkrdunkSampleCount
            )
            if pick.source == .yahooJp { return "Yahoo! Auctions JP" }
            if pick.source == .snkrdunk { return "Snkrdunk" }
        }
        return nil
    }

    /// Suppress the change-percent badge when the hero is showing a
    /// JP-scraper price (Yahoo! or Snkrdunk). The change columns track
    /// the Scrydex market_price, not the JP-derived median, so showing
    /// the delta would be misleading.
    private var suppressHeroChangeBadge: Bool {
        isJapaneseCard && selectJpPriceSource(
            yahooJpPrice: cardMetrics?.yahooJpPrice,
            yahooJpSampleCount: cardMetrics?.yahooJpSampleCount,
            snkrdunkPrice: cardMetrics?.snkrdunkPrice,
            snkrdunkSampleCount: cardMetrics?.snkrdunkSampleCount
        ).price != nil
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                heroSection
                    // Soft fade during EN/JP swap. Animates back to 1.0
                    // automatically once .task(id:) clears
                    // togglingLanguage after cardMetrics arrives. The
                    // duration is shorter than the typical metrics
                    // round-trip so the user sees the fade finish at
                    // roughly the same time the new data lands.
                    .opacity(togglingLanguage ? 0.55 : 1.0)
                    .animation(.easeInOut(duration: 0.25), value: togglingLanguage)
                if scanImageHash != nil {
                    correctionPrompt
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }
                detailContent
            }
            .background(alignment: .top) {
                // Accent glow — centered on card, bleeds into content below.
                // Switches to JP-red for Japanese cards so the entire view
                // reads as JP-themed at a glance.
                Ellipse()
                    .fill(detailAccent)
                    .opacity(0.25)
                    .blur(radius: 120)
                    .frame(width: 380, height: 500)
                    .offset(y: 180)
                    .allowsHitTesting(false)
            }
        }
        .coordinateSpace(name: "scroll")
        .background(PA.Colors.background)
        .overlay(alignment: .bottomTrailing) {
            // Stacked floating actions, both stay in place during scroll.
            // Wishlist sits above the primary "+" FAB at a smaller size +
            // frosted background so the visual hierarchy reads as
            // primary (Add to Portfolio) → secondary (Wishlist).
            VStack(spacing: 12) {
                WatchlistButton(
                    slug: activeCard.id,
                    cardName: activeCard.name,
                    setName: activeCard.setName,
                    compact: true
                )
                addHoldingFAB
            }
            .padding(.trailing, 20)
            .padding(.bottom, 20)
        }
        .overlay(alignment: .top) {
            if showAddedBanner {
                addedToPortfolioBanner
            }
        }
        .alert("Sign in to save \(activeCard.name)?", isPresented: $showSignInPromptForAdd) {
            Button("Sign In") {
                AuthService.shared.signIn()
                // pendingAddAfterSignIn stays true; the .onChange below
                // catches the isAuthenticated flip and runs the save.
            }
            Button("Cancel", role: .cancel) {
                pendingAddAfterSignIn = false
            }
        } message: {
            Text("Sign in and we'll save this card to your portfolio automatically. You can adjust grade and cost basis afterwards.")
        }
        .alert("Couldn't save", isPresented: Binding(
            get: { autoAddError != nil },
            set: { if !$0 { autoAddError = nil } }
        )) {
            Button("OK", role: .cancel) { autoAddError = nil }
        } message: {
            Text(autoAddError ?? "")
        }
        .onChange(of: AuthService.shared.isAuthenticated) { wasAuthed, isAuthed in
            // Deferred-action handoff: when the user signs in while we're
            // holding a pending add for this card, fire the save in the
            // background. Guarded by pendingAddAfterSignIn so an unrelated
            // re-auth (token refresh on app foreground, etc.) doesn't
            // accidentally re-add the card.
            if !wasAuthed && isAuthed && pendingAddAfterSignIn {
                pendingAddAfterSignIn = false
                Task { await autoSavePendingHolding() }
            }
        }
        .sheet(isPresented: $showCorrectionSheet) {
            if let hash = scanImageHash {
                // predictedSlug records what the SCANNER MODEL guessed,
                // not what the user is currently viewing. Use card.id
                // (the immutable navigation input) so toggling EN↔JP
                // mid-correction doesn't contaminate scan-eval audit
                // data with the paired slug. This is exactly why
                // CardDetailView keeps `let card` alongside the
                // mutable @State activeCard.
                EvalSeedingView(
                    mode: .correction(imageHash: hash, predictedSlug: card.id),
                    scanImage: scanImage,
                    correctionMetadata: scanCorrectionMetadata,
                    isPresented: $showCorrectionSheet
                )
            }
        }
        // activeCard.id is part of the key so an EN/JP toggle reloads
        // the chart even when the other dimensions (timeframe, price
        // mode, selected printing) happen to match. Without it,
        // paired JP cards — which currently get an empty
        // availablePrintings array from fetchPrintings, so
        // selectedPrintingId stays nil on both sides — would inherit
        // the EN card's chart-cleared state and never refetch.
        .task(id: "\(activeCard.id)|\(selectedTimeframe.rawValue)|\(selectedPriceMode)|\(selectedPrintingId ?? "")") {
            await loadChart()
        }
        // Keyed by activeCard.id so the entire data-load fan-out re-fires
        // when the user taps the EN/JP toggle and we swap activeCard.
        // Without the id, SwiftUI runs the task only on first appearance
        // and the toggled view would stay frozen on the original slug's
        // data.
        .task(id: activeCard.id) {
            // Cross-language pairing lookup. Hits /api/cards/[slug]/detail
            // which now carries canonical.pairedSlug + pairedLanguage. A
            // failed fetch (table missing, network blip) leaves the
            // toggle hidden — degrades silently.
            let pairing: CardPairing? = try? await CardService.shared.fetchCardPairing(slug: activeCard.id)
            await MainActor.run {
                pairedSlug = pairing?.pairedSlug
                pairedLanguage = pairing?.pairedLang
                pairedImageUrl = pairing?.pairedImageUrl
            }

            if premiumGate.isPro {
                cardProfile = try? await CardService.shared.fetchCardProfile(slug: activeCard.id)
            } else {
                cardProfile = nil
            }
            cardMetrics = try? await CardService.shared.fetchCardMetrics(slug: activeCard.id)
            // First metrics arrival is the cue to drop the toggle fade.
            // Cleared here rather than in the toggle tap so the fade
            // outlasts profile fetch latency (~100–400ms) and reads as
            // intentional motion instead of a flash.
            await MainActor.run { togglingLanguage = false }
            if AuthService.shared.isAuthenticated {
                friendActivity = try? await ActivityService.shared.fetchCardActivity(slug: activeCard.id)
            }
            // Fire a card_view personalization event once per appearance.
            await PersonalizationService.shared.track(
                PersonalizedEvent(
                    type: .cardView,
                    canonicalSlug: activeCard.id,
                    variantRef: selectedPrintingId.map { "\($0)::RAW" }
                )
            )
            // Load available finish variants. Ordering is handled downstream
            // by `toFinishGroups()` so the picker controls the visual order.
            if let printings = try? await CardService.shared.fetchPrintings(slug: activeCard.id) {
                let groups = printings.toFinishGroups()
                let initialId = groups.first?.defaultPrintingId ?? printings.first?.id
                await MainActor.run {
                    availablePrintings = printings
                    if selectedPrintingId == nil { selectedPrintingId = initialId }
                }
            }
            // Load condition-based prices
            if let prices = try? await CardService.shared.fetchConditionPrices(
                slug: activeCard.id,
                printingId: selectedPrintingId
            ) {
                await MainActor.run { conditionPrices = prices }
            }
            // Load per-bucket graded market summary stats. Each card may
            // have several rows per bucket (one canonical printing_id=NULL
            // aggregate plus one row per printing). Pick the best row per
            // bucket: prefer canonical (NULL) since it aggregates all
            // printings; fall back to the printing-scoped row with the
            // most snapshot_count_30d data; final fallback to whatever
            // row we have.
            if let rows = try? await CardService.shared.fetchGradedCardMetrics(slug: activeCard.id) {
                var grouped: [String: [GradedCardMetricRow]] = [:]
                for row in rows {
                    grouped[row.grade, default: []].append(row)
                }
                var resolved: [String: GradedCardMetricRow] = [:]
                for (bucket, candidates) in grouped {
                    if let canonical = candidates.first(where: { $0.printingId == nil }) {
                        resolved[bucket] = canonical
                    } else {
                        let best = candidates.max { ($0.snapshotCount30d ?? 0) < ($1.snapshotCount30d ?? 0) }
                        if let best { resolved[bucket] = best }
                    }
                }
                await MainActor.run { gradedCardMetricsByBucket = resolved }
            }
            // Load available graded options lazily
            if let rows = try? await CardService.shared.fetchGradedVariantMetrics(slug: activeCard.id) {
                let validProviders: Set<String> = ["PSA", "CGC", "BGS", "TAG"]
                let validBuckets: Set<String> = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"]
                let options = rows
                    .filter { validProviders.contains($0.provider) && validBuckets.contains($0.grade) }
                    .filter { ($0.historyPoints30d ?? 0) >= 3 || $0.providerAsOfTs != nil }
                    .map { PriceMode.graded(provider: $0.provider, bucket: $0.grade) }
                let seen = NSMutableOrderedSet()
                var unique: [PriceMode] = []
                for opt in options {
                    let key = "\(opt)" as NSString
                    if !seen.contains(key) {
                        seen.add(key)
                        unique.append(opt)
                    }
                }
                await MainActor.run {
                    availableGradedOptions = unique
                    gradedMetricsLoaded = true
                    // Pre-select the first available agency and its highest grade
                    if let first = unique.first, case .graded(let p, let b) = first {
                        selectedGradingAgency = p
                        selectedGradeBucket = b
                    }
                }
            }
        }
        .sheet(isPresented: $showAddHolding) {
            AddHoldingSheet(preselectedCard: activeCard.asSearchResult)
        }
        .onChange(of: selectedPrintingId) {
            Task {
                // Re-fetch the per-printing metrics row so the hero
                // price reflects the selected finish. The view-side
                // COALESCE in public_card_metrics means a per-printing
                // query that has no yahoo_jp_card_prices row yet for
                // that printing still falls back to the canonical
                // blended median — no need for two queries.
                //
                // 2026-05-13: this lights up the per-printing UX fix
                // shipped in PR #44. Cards with multiple printings
                // (HOLO + Reverse Holo / NON_HOLO) now show different
                // hero prices when the user taps a different pill.
                if let metrics = try? await CardService.shared.fetchCardMetrics(
                    slug: activeCard.id,
                    printingId: selectedPrintingId
                ) {
                    await MainActor.run { cardMetrics = metrics }
                }
                if let prices = try? await CardService.shared.fetchConditionPrices(
                    slug: activeCard.id,
                    printingId: selectedPrintingId
                ) {
                    await MainActor.run { conditionPrices = prices }
                }
            }
        }
        .onChange(of: premiumGate.isPro) { _, isPro in
            Task {
                if isPro {
                    cardProfile = try? await CardService.shared.fetchCardProfile(slug: activeCard.id)
                } else {
                    cardProfile = nil
                }
            }
        }
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    PAHaptics.tap()
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial.opacity(0.5))
                        .clipShape(Circle())
                }
                .accessibilityLabel("Back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 8) {
                    // Share — produces the same popalpha.ai/c/<slug> URL
                    // that the AASA file declares as a Universal Link
                    // path. Tapping a shared link from Messages/Mail/etc.
                    // opens the recipient's PopAlpha app directly on the
                    // card detail page (DeepLinkRouter +
                    // MarketplaceView consumePendingDeepLink). When the
                    // app isn't installed, the URL falls through to the
                    // web card detail page. Doubles as a quick way to
                    // self-test the Universal Links pipeline during
                    // TestFlight.
                    if let shareURL = URL(string: "https://popalpha.ai/c/\(activeCard.id)") {
                        ShareLink(
                            item: shareURL,
                            subject: Text(activeCard.name.isEmpty ? "PopAlpha card" : activeCard.name)
                        ) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(PA.Colors.text)
                                .frame(width: 36, height: 36)
                                .background(.ultraThinMaterial.opacity(0.5))
                                .clipShape(Circle())
                        }
                        .accessibilityLabel("Share card")
                    }

                    // "Add to Portfolio" lives in the floating action
                    // button at the bottom-right of the screen — see
                    // addHoldingFAB on the root view. Keeps the header
                    // clean and the primary action persistent during
                    // scroll.
                }
            }
        }
    }

    // MARK: - Hero (matches web canonical-card-floating-hero)

    /// Shown only when the user arrived at this detail view via a
    /// scanner identify. Lets them flag "that's not the card I
    /// scanned" and feed the correct slug back into the eval corpus,
    /// where it becomes regression-test material + fine-tuning fodder.
    private var correctionPrompt: some View {
        Button {
            PAHaptics.tap()
            showCorrectionSheet = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(detailAccent)
                Text("Not this card? Tell the scanner what it actually was.")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(detailAccent.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(detailAccent.opacity(0.25), lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
    }

    private var heroSection: some View {
        GeometryReader { geo in
            let scrollY = geo.frame(in: .named("scroll")).minY
            let progress = max(0, min(-scrollY / 350, 1))

            ZStack {
                Color.clear // fill GeometryReader
                // Freefloating, drag-to-spin card
                if let url = activeCard.imageURL {
                    flippableHeroCard(url: url)
                        .scaleEffect(1.0 - CGFloat(progress) * 0.08)
                        .opacity(1.0 - CGFloat(progress) * 0.6)
                        .offset(y: CGFloat(-progress) * 40.0)
                        .padding(.horizontal, 40)
                        .padding(.top, 12)
                        .padding(.bottom, 8)
                } else {
                    heroPlaceholder
                        .padding(.horizontal, 40)
                        .padding(.top, 12)
                }

            }
        }
        .frame(height: 420)
    }

    /// Two-faced 3D card. Front is the standard LazyImage hero; back is the
    /// bundled Pokémon TCG card back asset. Horizontal drag rotates the
    /// stack around its Y axis; release snaps to the nearest face. Front
    /// and back swap visibility at the 90°/270° crossings so the user
    /// never sees the mirrored backside of either face.
    @ViewBuilder
    private func flippableHeroCard(url: URL) -> some View {
        let normalized = ((spinAngle.truncatingRemainder(dividingBy: 360)) + 360)
            .truncatingRemainder(dividingBy: 360)
        let isFrontFacing = normalized < 90 || normalized > 270

        ZStack {
            LazyImage(url: url) { state in
                if let image = state.image {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxHeight: 420)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(.white.opacity(0.1), lineWidth: 0.5)
                        )
                } else if state.error != nil {
                    heroPlaceholder
                } else {
                    heroPlaceholder
                        .overlay(ProgressView().tint(PA.Colors.muted))
                }
            }
            .shadow(color: .black.opacity(0.8), radius: 24, x: 0, y: 16)
            .opacity(isFrontFacing ? 1 : 0)

            // JP cards get the Japanese back; everything else (EN + any
            // language we don't have a back asset for) falls back to the
            // English back. isJapaneseCard handles the early-render window
            // before cardMetrics arrives via the "-jp" slug-suffix check,
            // so the back stays correct across an EN/JP language toggle.
            Image(isJapaneseCard ? "PokemonCardBackJP" : "PokemonCardBack")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(.white.opacity(0.1), lineWidth: 0.5)
                )
                .shadow(color: .black.opacity(0.8), radius: 24, x: 0, y: 16)
                // Pre-rotated 180° so the asset reads un-mirrored when
                // the outer rotation has flipped the card to face the
                // camera from behind.
                .rotation3DEffect(.degrees(180), axis: (x: 0, y: 1, z: 0))
                .opacity(isFrontFacing ? 0 : 1)
        }
        .rotation3DEffect(
            .degrees(spinAngle),
            axis: (x: 0, y: 1, z: 0),
            perspective: 0.5
        )
        // simultaneousGesture (not .gesture) so the parent ScrollView keeps
        // recognizing vertical pans on the hero. The first onChanged sample
        // (which fires once cumulative movement crosses minimumDistance)
        // classifies the drag for life: dominantly-horizontal → .engaged,
        // anything else → .rejected. Subsequent samples never re-classify,
        // so a drag that starts as a scroll cannot retroactively rotate
        // the card if the finger drifts sideways.
        .simultaneousGesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    if case .rejected = spinDragState { return }
                    let dx = abs(value.translation.width)
                    let dy = abs(value.translation.height)
                    if case .undecided = spinDragState {
                        if dx > dy * 1.4 {
                            spinDragState = .engaged
                        } else {
                            spinDragState = .rejected
                            return
                        }
                    }
                    // 0.6°/pt — ~150pt drag ≈ 90° rotation, tuned for a
                    // wrist-flick feel without runaway spins.
                    spinAngle = spinDragStart + Double(value.translation.width) * 0.6
                }
                .onEnded { _ in
                    let wasEngaged = spinDragState == .engaged
                    spinDragState = .undecided
                    guard wasEngaged else { return }
                    let target = (spinAngle / 180.0).rounded() * 180.0
                    withAnimation(.spring(response: 0.45, dampingFraction: 0.78)) {
                        spinAngle = target
                    }
                    spinDragStart = target
                    PAHaptics.selection()
                }
        )
    }

    private var heroPlaceholder: some View {
        RoundedRectangle(cornerRadius: 20)
            .fill(PA.Colors.hairline(0.03))
            .aspectRatio(63.0 / 88.0, contentMode: .fit)
            .frame(maxHeight: 420)
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(PA.Colors.border, lineWidth: 1)
            )
            .overlay(
                VStack(spacing: 12) {
                    Image("PopAlphaLogoTransparent")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 48, height: 48)
                        .opacity(0.12)
                    Text(activeCard.cardNumber)
                        .font(.system(size: 14, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.3))
                }
            )
    }

    // MARK: - Cross-language toggle

    /// Renders the EN | JP segmented control below the title row.
    /// Caller guards on pairedSlug being non-nil so we always have a
    /// swap target when this is mounted. The active segment's fill is
    /// language-specific (EN blue, JP red) so the control reads as
    /// both a state indicator AND a hint about what the other side
    /// will look like.
    private func languageToggleControl(partnerSlug: String) -> some View {
        let currentLang: CardLanguage = isJapaneseCard ? .jp : .en
        return HStack(spacing: 0) {
            languageSegment(.en, isActive: currentLang == .en) {
                if currentLang != .en { swapToPairedLanguage(targetSlug: partnerSlug) }
            }
            languageSegment(.jp, isActive: currentLang == .jp) {
                if currentLang != .jp { swapToPairedLanguage(targetSlug: partnerSlug) }
            }
        }
        .padding(2)
        .background(
            Capsule().fill(PA.Colors.hairline(0.05))
        )
        .overlay(
            Capsule().strokeBorder(PA.Colors.border, lineWidth: 0.5)
        )
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Card language")
    }

    private func languageSegment(
        _ lang: CardLanguage,
        isActive: Bool,
        onTap: @escaping () -> Void
    ) -> some View {
        let activeFill: Color = lang == .jp ? PA.AxisColors.marketHeat : PA.Colors.accent
        return Button(action: onTap) {
            Text(lang.displayLabel)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(isActive ? .white : PA.Colors.muted)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(isActive ? activeFill : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .accessibilityLabel(lang == .en ? "English" : "Japanese")
    }

    /// Replaces activeCard with a stub keyed on the paired slug,
    /// triggering .task(id: activeCard.id) to re-fetch everything for
    /// the new language. Stub bridges name/setName/rarity/etc. from
    /// the current activeCard so the title block doesn't go blank
    /// during the ~300ms metrics fetch; canonical_name is identical
    /// across EN/JP rows in our schema (the English Pokemon name —
    /// the Japanese rendering lives in canonical_name_native and
    /// renders via the bilingual title path once cardMetrics arrives).
    /// imageURL is set from pairedImageUrl when present so the hero
    /// swaps directly EN <-> JP without falling back to
    /// heroPlaceholder during the metrics round-trip.
    private func swapToPairedLanguage(targetSlug: String) {
        guard !togglingLanguage else { return }
        // Capture the paired image URL BEFORE we clear pairedImageUrl
        // below — once activeCard.id flips and .task(id:) refetches,
        // this state gets repopulated with the paired card's own
        // pairing target (i.e., the original slug). For the stub we
        // want the URL we already have in hand.
        let stubImageURL = pairedImageUrl.flatMap(URL.init(string:))
        withAnimation(.easeOut(duration: 0.18)) {
            togglingLanguage = true
        }
        // Wipe per-slug caches so the UI doesn't briefly render stale
        // data for the new slug while .task(id:) refetches.
        cardProfile = nil
        cardMetrics = nil
        chartPrices = []
        chartTimestamps = []
        chartError = nil
        availablePrintings = []
        selectedPrintingId = nil
        printingHeroPrice = nil
        conditionPrices = []
        gradedCardMetricsByBucket = [:]
        availableGradedOptions = []
        gradedMetricsLoaded = false
        gradedHeroPrice = nil
        // Reset the price-mode selection back to Near Mint. Leaving
        // it on .graded after a swap would strand the paired card in
        // graded view with no data — fetchGradedVariantMetrics may
        // return nothing for this slug, and even when it does, the
        // user's prior PSA/G10 selection probably isn't the right
        // default for an unrelated paired print. Reset companion
        // grade selectors to their init defaults too.
        selectedPriceMode = .nearMint
        selectedGradingAgency = "PSA"
        selectedGradeBucket = "G10"
        pairedSlug = nil
        pairedLanguage = nil
        pairedImageUrl = nil

        activeCard = MarketCard(
            id: targetSlug,
            name: activeCard.name,
            setName: activeCard.setName,
            cardNumber: activeCard.cardNumber,
            price: 0,
            changePct: nil,
            changeWindow: activeCard.changeWindow,
            rarity: activeCard.rarity,
            sparkline: [],
            imageGradient: activeCard.imageGradient,
            imageURL: stubImageURL,
            confidenceScore: nil
        )
    }

    // MARK: - Detail Content

    private var detailContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            // 1. Title + Price section (recognition + current market state)
            pricingSection

            // 2. Finish variant pill selector — identity cue, stays near title
            if shouldShowFinishPicker {
                finishPillSection
            }

            // PopAlpha insight — the wedge. First real payoff on the
            // page; anchors the user around our interpretation before
            // raw mechanics. (Watchlist row was removed; "Add to
            // Portfolio" lives in the floating action button on the
            // root view, so this card stays in its previous slot.)
            if cardProfile != nil || !premiumGate.isPro {
                aiBriefSection
            }

            // 5 + 6. Practical pricing cluster — grade toggle + condition
            // breakdown grouped tighter so they read as one details block
            // rather than two equal siblings. In graded mode the condition
            // breakdown is replaced by the per-bucket market summary.
            VStack(alignment: .leading, spacing: 12) {
                gradePillSection

                if !conditionPrices.isEmpty && !selectedPriceMode.isGraded {
                    conditionPriceSection
                }

                if selectedPriceMode.isGraded {
                    gradedMarketSummarySection
                }
            }

            // 7. Chart section — supporting evidence after the read.
            chartSection

            // 8. Personalized insight ("How this fits your style") — secondary
            // differentiated layer; renders its own fallback when signal is thin.
            PersonalizedInsightCardView(
                canonicalSlug: activeCard.id,
                variantRef: selectedPrintingId.map { "\($0)::RAW" }
            )

            // 9. Details grid — metadata break after the narrative sections.
            detailsGrid
                .padding(.top, 8)

            // 10. Friend activity (only when authenticated + signal exists)
            if let activity = friendActivity, activity.ownerCount > 0 || !activity.recent.isEmpty {
                friendActivitySection(activity)
            }

            // 11. Market intelligence — deepest diagnostics last.
            //     For JP cards this section also surfaces the Yahoo! JP
            //     observed_at timestamp + sample-count confidence so the
            //     user can audit the hero price's freshness.
            marketInfoSection
                .padding(.top, 6)
        }
        .padding(PA.Layout.sectionPadding)
    }

    private var pricingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    NavigationLink {
                        SetDetailView(setName: activeCard.setName)
                    } label: {
                        HStack(spacing: 4) {
                            // For JP cards, prefer the native (Japanese) set
                            // name on the chevron link so a JP-collector
                            // glance shows 拡張パック; the EN equivalent
                            // already lives in the bilingual title block.
                            Text(setNameForLink)
                                .font(PA.Typography.cardSubtitle)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .foregroundStyle(detailAccent)
                    }
                    .buttonStyle(.plain)

                    // Bilingual hero name. English on top (familiar to the
                    // English-speaking operator); Japanese smaller below
                    // when present. The Japanese name is dimmer + smaller
                    // so it reads as a secondary identity rather than
                    // competing with the primary EN text.
                    Text(activeCard.name)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                    if isJapaneseCard, let nativeName = cardMetrics?.canonicalNameNative, !nativeName.isEmpty {
                        Text(nativeName)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(PA.Colors.muted)
                            .accessibilityLabel("Japanese name: \(nativeName)")
                    }
                }

                Spacer()

                // Rarity badge — JP cards swap the accent tint to the
                // detailAccent (red); secret rare keeps gold so that
                // semantic still reads.
                Text(activeCard.rarity.label.uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(activeCard.rarity == .secretRare ? PA.Colors.gold : detailAccent)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        (activeCard.rarity == .secretRare ? PA.Colors.gold : detailAccent).opacity(0.12)
                    )
                    .clipShape(Capsule())
            }

            // EN/JP language toggle. Renders only when card_translations
            // has a pairing for this card; absent otherwise so the
            // pricing block doesn't grow a disabled control for the
            // ~60–80% of cards that lack a JP/EN counterpart.
            if let partnerSlug = pairedSlug, pairedLanguage != nil {
                languageToggleControl(partnerSlug: partnerSlug)
            }

            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(currentHeroPrice)
                    .font(PA.Typography.heroPrice)
                    .foregroundStyle(PA.Colors.text)

                // Suppress the change badge when the hero price is
                // sourced from Yahoo! JP — change_pct_24h/7d track the
                // Scrydex market_price, not the Yahoo!-derived median,
                // so showing a Scrydex delta next to a Yahoo! price
                // would imply causality that doesn't exist.
                if !selectedPriceMode.isGraded && !suppressHeroChangeBadge && !isAbundantNearMintHeroPrice {
                    HStack(spacing: 4) {
                        Image(systemName: heroChange.direction.arrowSymbol)
                            .font(.system(size: 12, weight: .bold))
                            // Decorative — adjacent percent text conveys direction.
                            .accessibilityHidden(true)
                        Text(heroChange.text)
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(heroChange.direction.color)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(heroChange.direction.accessibilityWord) \(heroChange.text)")

                    Text(heroChange.window)
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                }
            }

            if isAbundantNearMintHeroPrice {
                Text(abundantRawCardDetailLabel)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .accessibilityLabel("Usually under two dollars. Pay what feels fair.")
            }

            // Source attribution for JP cards. When BOTH Yahoo! JP and
            // Snkrdunk have data, render each as its own line so the
            // user can see both signals side-by-side and judge for
            // themselves (the hero shows the confidence-pick winner;
            // these lines show the unblended sources). When only one
            // is present, render just that one — same behavior as
            // pre-Snkrdunk.
            if isJapaneseCard {
                let yj = cardMetrics?.yahooJpPrice ?? 0
                let snk = cardMetrics?.snkrdunkPrice ?? 0
                if yj > 0 || snk > 0 {
                    VStack(alignment: .leading, spacing: 4) {
                        if yj > 0, let metrics = cardMetrics {
                            sourceAttributionLine(
                                source: "Yahoo! Auctions JP",
                                usd: metrics.yahooJpPrice,
                                jpy: metrics.yahooJpPriceJpy,
                                sampleCount: metrics.yahooJpSampleCount
                            )
                        }
                        if snk > 0, let metrics = cardMetrics {
                            sourceAttributionLine(
                                source: "Snkrdunk",
                                usd: metrics.snkrdunkPrice,
                                jpy: nil, // Snkrdunk's English API serves USD directly
                                sampleCount: metrics.snkrdunkSampleCount
                            )
                        }
                    }
                }
            }
        }
    }

    /// Set-link text in the pricingSection. JP cards show the native
    /// (Japanese) set name (拡張パック) since the EN translation
    /// ("Expansion Pack") is unfamiliar shorthand, and the EN release
    /// equivalence ("Base Set") doesn't live in our data model — the
    /// importer stores only the Scrydex-translated name. Falls back to
    /// the EN set_name for non-JP cards.
    private var setNameForLink: String {
        if isJapaneseCard, let native = cardMetrics?.setNameNative, !native.isEmpty {
            return native
        }
        return activeCard.setName
    }

    // MARK: - Chart (live data per timeframe)

    private var activeChartPrices: [Double] {
        chartPrices.isEmpty ? activeCard.sparkline : chartPrices
    }

    private var activeChartTimestamps: [String] {
        chartTimestamps
    }

    private var chartDirection: ChangeDirection {
        guard activeChartPrices.count >= 2, let first = activeChartPrices.first, let last = activeChartPrices.last else {
            return heroChange.direction
        }
        return ChangeDirection.from(last - first)
    }

    /// Authoritative 24H change for the hero badge. The parent (set browser,
    /// signal board, search) passes a `MarketCard.changePct` whose freshness
    /// depends on whatever bulk fetch they ran — sometimes 0 when their
    /// metrics map missed the slug. Once `cardMetrics` lands here, prefer it.
    private var heroChange: (pct: Double?, direction: ChangeDirection, text: String, window: String) {
        let pct: Double?
        let window: String
        if let metrics = cardMetrics, let m24 = metrics.changePct24h {
            pct = m24; window = "24H"
        } else if let metrics = cardMetrics, let m7 = metrics.changePct7d {
            pct = m7; window = "7D"
        } else {
            pct = activeCard.changePct; window = activeCard.changeWindow
        }
        let text: String
        if let p = pct {
            let sign = p > 0 ? "+" : ""
            text = "\(sign)\(String(format: "%.1f", p))%"
        } else {
            text = "—"
        }
        return (pct, ChangeDirection.from(pct), text, window)
    }

    private var chartSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Timeframe picker
            HStack(spacing: 0) {
                ForEach(ChartTimeframe.allCases, id: \.self) { tf in
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            selectedTimeframe = tf
                        }
                    } label: {
                        Text(tf.rawValue)
                            .font(PA.Typography.badge)
                            .foregroundStyle(
                                selectedTimeframe == tf ? PA.Colors.text : PA.Colors.muted
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(
                                selectedTimeframe == tf ? PA.Colors.surfaceSoft : .clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(PA.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Interactive chart
            ZStack {
                InteractiveChartView(
                    data: activeChartPrices,
                    timestamps: activeChartTimestamps,
                    direction: chartDirection,
                    lineWidth: 2,
                    height: 140
                )
                .opacity(chartLoading || (chartError != nil && chartPrices.isEmpty) ? 0.3 : 1)
                .animation(.easeOut(duration: 0.2), value: chartLoading)

                if chartLoading {
                    ProgressView()
                        .tint(detailAccent)
                } else if let error = chartError, chartPrices.isEmpty {
                    // Chart fetch failed and we have no cached data to
                    // fall back on. Without this, the chart row would
                    // render an empty grid with no explanation —
                    // Apple's airplane-mode test would see infinite
                    // dim chart + no retry path.
                    VStack(spacing: 10) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(PA.Colors.muted)
                        Text(error)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(PA.Colors.muted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        Button {
                            Task { await loadChart() }
                        } label: {
                            Text("Retry")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(detailAccent)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 6)
                                .overlay(
                                    Capsule().stroke(detailAccent.opacity(0.5), lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Retry loading chart")
                    }
                }
            }
            .padding(.vertical, 4)

            if !chartPrices.isEmpty {
                HStack(spacing: 6) {
                    Circle()
                        .fill(detailAccent.opacity(0.7))
                        .frame(width: 4, height: 4)
                    Text("Calibrated on \(chartPrices.count) data point\(chartPrices.count == 1 ? "" : "s") · \(selectedTimeframe.rawValue)")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.4)
                        .foregroundStyle(PA.Colors.muted)
                }
            }
        }
        .padding(16)
        .glassSurface()
    }

    private func loadChart() async {
        chartLoading = true
        chartError = nil
        let requestSlug = activeCard.id
        let requestMode = selectedPriceMode
        let requestPrintingId = selectedPrintingId
        let requestTimeframe = selectedTimeframe

        do {
            let points: [PricePoint]
            switch requestMode {
            case .nearMint:
                // Only use printing-specific history when the user can
                // actually choose a finish. For single-printing cards, the
                // printing_id filter matches multiple provider_variant cohorts
                // (e.g. ':normal' + ':reverseholofoil' under one printing) —
                // the canonical view resolves that to a single dominant
                // cohort via preferred_canonical_raw_variant_ref. See
                // supabase/migrations/20260422200000_canonical_pin_provider_variant.sql.
                if let printingId = requestPrintingId, availablePrintings.count > 1 {
                    points = try await CardService.shared.fetchPrintingPriceHistory(
                        slug: requestSlug,
                        printingId: printingId,
                        timeframe: requestTimeframe
                    )
                } else {
                    points = try await CardService.shared.fetchPriceHistory(
                        slug: requestSlug,
                        timeframe: requestTimeframe
                    )
                }
            case .graded(let provider, let bucket):
                // Pass the bucket name (G8/G9/G9_5/G10/G10_PERFECT) DIRECTLY.
                // price_history_points stores graded variant_refs in the
                // long form `…::GRADED::PROVIDER::BUCKET::RAW` using the
                // bucket *name*, not the constraint token (8/9/9_5/10/…).
                // The converter previously here was a leftover from when
                // iOS queried variant_metrics short-form refs and is wrong
                // after commit 96d89bb moved the chart query to
                // price_history_points.
                if let printingId = requestPrintingId {
                    points = try await CardService.shared.fetchPrintingGradedPriceHistory(
                        slug: requestSlug,
                        printingId: printingId,
                        provider: provider,
                        bucket: bucket,
                        timeframe: requestTimeframe
                    )
                } else {
                    points = try await CardService.shared.fetchGradedPriceHistory(
                        slug: requestSlug,
                        provider: provider,
                        bucket: bucket,
                        timeframe: requestTimeframe
                    )
                }
            }
            await MainActor.run {
                guard activeCard.id == requestSlug,
                      selectedPriceMode == requestMode,
                      selectedPrintingId == requestPrintingId,
                      selectedTimeframe == requestTimeframe else { return }
                chartPrices = points.map(\.price)
                chartTimestamps = points.map(\.ts)
                chartLoading = false
                switch requestMode {
                case .graded:
                    gradedHeroPrice = points.last?.price
                    printingHeroPrice = nil
                case .nearMint:
                    gradedHeroPrice = nil
                    printingHeroPrice = nil
                }
            }
        } catch {
            await MainActor.run {
                guard activeCard.id == requestSlug,
                      selectedPriceMode == requestMode,
                      selectedPrintingId == requestPrintingId,
                      selectedTimeframe == requestTimeframe else { return }
                chartPrices = []
                chartTimestamps = []
                chartLoading = false
                // Surface a short, actionable message; the global
                // OfflineBanner already explains "you're offline" if
                // that's the cause, so keep this generic.
                chartError = "Couldn't load price history."
            }
        }
    }

    // MARK: - Details Grid
    // Every tile derives its value from live card / metrics data so the
    // section feels intentional rather than placeholder. Missing data
    // degrades to a muted em-dash rather than leaving the UI looking broken.

    private struct MetaTile: Identifiable {
        let id = UUID()
        let title: String
        let value: String
        let tone: DetailTone
    }

    private var metaTiles: [MetaTile] {
        var tiles: [MetaTile] = []

        let setName = activeCard.setName.trimmingCharacters(in: .whitespacesAndNewlines)
        tiles.append(MetaTile(
            title: "Set",
            value: setName.isEmpty ? "—" : setName,
            tone: setName.isEmpty ? .muted : .neutral
        ))

        let rawNumber = activeCard.cardNumber.trimmingCharacters(in: .whitespaces)
        let hasNumber = !rawNumber.isEmpty
        let displayedNumber: String = {
            guard hasNumber else { return "—" }
            return rawNumber.hasPrefix("#") ? rawNumber : "#\(rawNumber)"
        }()
        tiles.append(MetaTile(
            title: "Number",
            value: displayedNumber,
            tone: hasNumber ? .neutral : .muted
        ))

        let confidence = confidenceDescriptor
        tiles.append(MetaTile(title: "Confidence", value: confidence.label, tone: confidence.tone))

        let liquidity = liquidityDescriptor
        tiles.append(MetaTile(title: "Liquidity", value: liquidity.label, tone: liquidity.tone))

        return tiles
    }

    private var detailsGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
            spacing: 10
        ) {
            ForEach(metaTiles) { tile in
                detailTile(title: tile.title, value: tile.value, tone: tile.tone)
            }
        }
    }

    private func detailTile(title: String, value: String, tone: DetailTone = .neutral) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .tracking(0.4)
                .textCase(.uppercase)
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tone.color)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassSurface()
    }

    /// Derives a user-facing Confidence label from the numeric score
    /// attached to the card. Falls back to a muted em-dash when the
    /// signal isn't loaded yet.
    private var confidenceDescriptor: (label: String, tone: DetailTone) {
        guard let score = activeCard.confidenceScore else { return ("—", .muted) }
        if score >= 85 { return ("High", .accent) }
        if score >= 70 { return ("Solid", .accent) }
        if score >= 55 { return ("Watch", .neutral) }
        return ("Low", .muted)
    }

    /// Derives Liquidity from active listings (7D) with a snapshot-count
    /// fallback. This keeps the tile meaningful even when listings are
    /// sparse but price history is rich.
    private var liquidityDescriptor: (label: String, tone: DetailTone) {
        guard let metrics = cardMetrics else { return ("—", .muted) }
        let listings = metrics.activeListings7d ?? 0
        let snapshots = metrics.snapshotCount30d ?? 0
        if listings >= 15 || snapshots >= 12 { return ("Strong", .positive) }
        if listings >= 5 || snapshots >= 5 { return ("Moderate", .accent) }
        if listings >= 1 || snapshots >= 1 { return ("Thin", .neutral) }
        return ("—", .muted)
    }

    // MARK: - Action Buttons
    // Primary: Add to Collection — dominant, accent-filled, expands to
    // fill the remaining width so it clearly reads as the next logical
    // user action. Secondary: Wishlist — compact ghost pill.

    // MARK: - Floating Add-to-Portfolio FAB
    // Anchored bottom-trailing on the root view (overlay on the
    // ScrollView, not inside it) so it stays in place during scroll.
    // Replaces the previous two inline "Add to Portfolio" / "Add to
    // Collection" buttons in the header and primary action row.

    private var addHoldingFAB: some View {
        Button {
            PAHaptics.tap()
            handleAddTap()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(PA.Colors.background)
                .frame(width: 56, height: 56)
                .background(detailAccent)
                .clipShape(Circle())
                .shadow(color: detailAccent.opacity(0.4), radius: 12, x: 0, y: 4)
                .shadow(color: .black.opacity(0.25), radius: 6, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add to portfolio")
        .accessibilityHint("Opens the add-card sheet")
    }

    // MARK: - Sign-in gated add

    /// Routes the FAB tap based on auth state. Authenticated users go
    /// straight to the AddHoldingSheet so they can fill in cost basis;
    /// guests get a sign-in prompt that, on success, auto-saves this
    /// card with default values (RAW / qty 1 / no cost). The user can
    /// edit the lot afterwards via swipe-to-edit on the portfolio.
    private func handleAddTap() {
        if AuthService.shared.isAuthenticated {
            showAddHolding = true
        } else {
            pendingAddAfterSignIn = true
            showSignInPromptForAdd = true
        }
    }

    /// Fires when the auth flag flips during a pending add. Saves the
    /// current card to the portfolio with default values, surfaces a
    /// brief success banner, and clears the pending flag. Errors are
    /// captured into autoAddError so the user knows the save didn't
    /// land instead of silently dropping it.
    private func autoSavePendingHolding() async {
        do {
            try await HoldingsService.shared.addHolding(
                canonicalSlug: activeCard.id,
                grade: "RAW",
                qty: 1
            )
            await MainActor.run {
                PAHaptics.tap()
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                    showAddedBanner = true
                }
            }
            try? await Task.sleep(for: .seconds(2.5))
            await MainActor.run {
                withAnimation(.easeOut(duration: 0.25)) {
                    showAddedBanner = false
                }
            }
        } catch {
            await MainActor.run {
                autoAddError = "Couldn't save \(activeCard.name) — try again from the + button."
            }
        }
    }

    /// Banner overlay shown briefly after a deferred-add auto-save lands.
    private var addedToPortfolioBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PA.Colors.positive)
            Text("Added \(activeCard.name) to your portfolio")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(PA.Colors.hairline(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: 4)
        .padding(.top, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - AI Brief
    // Branded interpretation of the chart above. Mirrors the personalization
    // card's shaded-pill pattern but in PopAlpha blue — the title lives
    // inside the card, the left rail is inset so it sits cleanly within
    // the rounded corners rather than tracing them.

    @ViewBuilder
    private var aiBriefSection: some View {
        if let profile = cardProfile {
            aiBriefCard {
                aiBriefHeader(chip: profile.chip)
                aiBriefUnlockedBody(profile)
            }
        } else if !premiumGate.isPro {
            aiBriefCard {
                aiBriefHeader(chip: "Pro")
                aiBriefLockedPreview
            }
        }
    }

    private func aiBriefCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(detailAccent.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(alignment: .leading) {
            // Inset rounded rail — tucks inside the card's rounded
            // corners instead of trying to trace them.
            Capsule()
                .fill(detailAccent)
                .frame(width: 3)
                .padding(.vertical, 10)
                .padding(.leading, 2)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(detailAccent.opacity(0.35), lineWidth: 1)
        )
        .shadow(color: detailAccent.opacity(0.22), radius: 14, x: 0, y: 0)
        .shadow(color: .black.opacity(0.24), radius: 30, x: 0, y: 18)
        .sheet(isPresented: $showMarketSummaryPaywall) {
            PaywallView(context: .generic, surface: "card_detail_market_summary_teaser")
        }
    }

    private func aiBriefHeader(chip: String?) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(detailAccent)
            Text("Where this card stands today")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(detailAccent)
                .kerning(-0.2)
            Spacer(minLength: 0)
            if let chip = chip?.trimmingCharacters(in: .whitespacesAndNewlines), !chip.isEmpty {
                Text(chip)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(detailAccent.opacity(0.28))
                    .clipShape(Capsule())
                    .overlay(
                        Capsule()
                            .stroke(detailAccent.opacity(0.45), lineWidth: 1)
                    )
            }
        }
    }

    @ViewBuilder
    private func aiBriefUnlockedBody(_ profile: CardProfileResult) -> some View {
        Text(summaryHeadline(from: profile))
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(PA.Colors.text)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)

        if let interpretation = summaryInterpretation(from: profile) {
            Text(interpretation)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }

        if shouldShowThinDataNote {
            HStack(spacing: 6) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.system(size: 10, weight: .semibold))
                Text("Read calibrated for thin market depth")
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(PA.Colors.muted)
            .padding(.top, 2)
        }
    }

    private var aiBriefLockedPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Preview: Pro reads price movement, market depth, and collector demand for this card.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            LockedPreviewOverlay(
                ctaText: "Upgrade to Pro",
                blurRadius: 5,
                onTap: { showMarketSummaryPaywall = true }
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Momentum, liquidity, and confidence read")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.text.opacity(0.85))
                    Text("AI interpretation tuned to the card's current market signals and recent observations.")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineSpacing(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
            }
        }
    }

    /// Canonical one-line read — defaults to `summary_short` and trims
    /// any trailing whitespace / punctuation doubling that occasionally
    /// leaks through from the backend.
    private func summaryHeadline(from profile: CardProfileResult) -> String {
        profile.summaryShort.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Returns a distinct supporting line from `summary_long`. If the long
    /// form simply repeats the short form (a common backend pattern), we
    /// return nil so the card doesn't render duplicated copy.
    private func summaryInterpretation(from profile: CardProfileResult) -> String? {
        guard let long = profile.summaryLong else { return nil }
        let short = profile.summaryShort.trimmingCharacters(in: .whitespacesAndNewlines)
        let full = long.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !full.isEmpty else { return nil }
        if full.caseInsensitiveCompare(short) == .orderedSame { return nil }

        // Strip the headline when `long` begins with `short` verbatim,
        // then clean up the residue so we show only the fresh context.
        let remainder: String
        if full.lowercased().hasPrefix(short.lowercased()) {
            remainder = String(full.dropFirst(short.count))
        } else {
            remainder = full
        }

        let stripSet = CharacterSet(charactersIn: " .,;\t\n")
        var cleaned = remainder.trimmingCharacters(in: stripSet)
        guard !cleaned.isEmpty else { return nil }

        cleaned = cleaned
            .replacingOccurrences(of: ".,", with: ",")
            .replacingOccurrences(of: ",.", with: ".")
            .replacingOccurrences(of: " ,", with: ",")
            .replacingOccurrences(of: "  ", with: " ")

        let first = cleaned.prefix(1).uppercased()
        let body = first + cleaned.dropFirst()
        return body.hasSuffix(".") ? body : body + "."
    }

    /// Only surface the calibration note when we're genuinely working
    /// with thin data — keeps the screen from over-caveating healthy cards.
    private var shouldShowThinDataNote: Bool {
        let count = chartPrices.isEmpty ? activeCard.sparkline.count : chartPrices.count
        return count > 0 && count < 8
    }

    // MARK: - Market Info

    private var marketInfoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Market Intelligence")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)

            VStack(spacing: 8) {
                // Price source row reflects the actual provider feeding
                // the hero — Yahoo! JP for JP cards with scraped data,
                // Scrydex otherwise.
                infoRow(label: "Price Source", value: priceSourceDescription)
                // Last-refreshed + sample-confidence rows track whichever
                // JP source the hero is showing (confidence-pick winner
                // between Yahoo! JP and Snkrdunk). When both have data,
                // we pick the same winner the hero does — so the user
                // sees a coherent "Snkrdunk says $X, refreshed Y, with
                // n samples" story.
                if isJapaneseCard, let observedAt = primaryJpObservedAt {
                    infoRow(label: "Last Refreshed", value: formatYahooJpObservedAt(observedAt))
                } else {
                    infoRow(label: "Last Updated", value: "2 min ago")
                }
                if isJapaneseCard, let count = primaryJpSampleCount {
                    infoRow(label: "Sample Confidence", value: formatYahooJpSampleCount(count))
                }
                infoRow(label: "7D Median", value: formatMedian7d(cardMetrics?.median7d))
                infoRow(label: "Volatility", value: "Low")
            }
            .padding(16)
            .glassSurface()
        }
    }

    /// Hero-price provenance label shown in Market Intelligence.
    /// Surfaces JP scraper status explicitly so users on a JP card
    /// understand whether they're seeing real JP-market data or a US
    /// fallback. States:
    ///   • JP card + both JP sources → "Yahoo! JP + Snkrdunk (sold archive)"
    ///   • JP card + only Yahoo! → "Yahoo! Auctions JP (sold archive)"
    ///   • JP card + only Snkrdunk → "Snkrdunk (sold archive)"
    ///   • JP card + neither → "PopAlpha market feeds (US fallback)" — explains
    ///     why a JP card might show a US-derived price.
    ///   • EN card → "PopAlpha market feeds"
    private var priceSourceDescription: String {
        if isJapaneseCard {
            let yj = (cardMetrics?.yahooJpPrice ?? 0) > 0
            let snk = (cardMetrics?.snkrdunkPrice ?? 0) > 0
            if yj && snk { return "Yahoo! JP + Snkrdunk (sold archive)" }
            if yj { return "Yahoo! Auctions JP (sold archive)" }
            if snk { return "Snkrdunk (sold archive)" }
            return "PopAlpha market feeds (US fallback)"
        }
        return "PopAlpha market feeds"
    }

    /// Single attribution line under the hero — shows the source name,
    /// optional JPY equivalent, and sample-count. Used twice on JP
    /// cards that have both Yahoo! and Snkrdunk data (the confidence-
    /// pick winner is already in the hero; these lines show the
    /// per-source detail). Inline rather than its own file because
    /// it's only used inside this view and adding a separate Swift
    /// file in the xcodeproj has risk (per project memory).
    @ViewBuilder
    private func sourceAttributionLine(
        source: String,
        usd: Double?,
        jpy: Double?,
        sampleCount: Int?
    ) -> some View {
        HStack(spacing: 8) {
            Text(source)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.textSecondary)
            if let usd, usd > 0 {
                Text("· $" + String(format: "%.2f", usd))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PA.Colors.textSecondary)
            }
            if let jpy {
                Text("· ¥" + (Int(jpy.rounded())).formatted())
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted)
            }
            if let count = sampleCount, count > 0 {
                Text("· n=\(count)")
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    // MARK: - Yahoo! JP helper formatters
    //
    // The standalone "Japanese Market" section was retired in favor of
    // surfacing JP price data through the hero (preferredHeroPrice +
    // the JPY/sample-count attribution row in pricingSection) and
    // through marketInfoSection's "Last Refreshed" / "Sample
    // Confidence" rows. These two helpers remain because both the
    // hero attribution and the market-info rows need to format JP
    // data consistently.

    private func formatYahooJpSampleCount(_ count: Int) -> String {
        // Confidence indicator. Below 5 sales the median is less stable,
        // so flag it so the user weighs the price accordingly.
        let confidence = count >= 10 ? "high" : count >= 5 ? "moderate" : "low"
        return "n=\(count) sales · \(confidence) confidence"
    }

    /// Whether the confidence-pick winner is Snkrdunk (vs Yahoo! JP).
    /// True only when both sources have data AND Snkrdunk has more
    /// sample sales. Same selection logic as preferredHeroPrice +
    /// heroPriceSourceLabel so the Market Intelligence panel tells a
    /// coherent per-source story.
    private var snkrdunkIsPrimaryJpSource: Bool {
        guard let metrics = cardMetrics else { return false }
        let yj = metrics.yahooJpPrice ?? 0
        let snk = metrics.snkrdunkPrice ?? 0
        if snk <= 0 { return false }
        if yj <= 0 { return true } // Snkrdunk is the only source
        return (metrics.snkrdunkSampleCount ?? 0) > (metrics.yahooJpSampleCount ?? 0)
    }

    /// observed_at from the JP source the hero is using. Nil when
    /// neither JP source has data.
    private var primaryJpObservedAt: String? {
        guard let metrics = cardMetrics else { return nil }
        if snkrdunkIsPrimaryJpSource { return metrics.snkrdunkObservedAt }
        if (metrics.yahooJpPrice ?? 0) > 0 { return metrics.yahooJpObservedAt }
        if (metrics.snkrdunkPrice ?? 0) > 0 { return metrics.snkrdunkObservedAt }
        return nil
    }

    /// sample_count from the JP source the hero is using. Nil when
    /// neither JP source has data.
    private var primaryJpSampleCount: Int? {
        guard let metrics = cardMetrics else { return nil }
        if snkrdunkIsPrimaryJpSource { return metrics.snkrdunkSampleCount }
        if (metrics.yahooJpPrice ?? 0) > 0 { return metrics.yahooJpSampleCount }
        if (metrics.snkrdunkPrice ?? 0) > 0 { return metrics.snkrdunkSampleCount }
        return nil
    }

    private func formatYahooJpObservedAt(_ iso: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = isoFormatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }

        let now = Date()
        let elapsed = now.timeIntervalSince(date)
        let hours = elapsed / 3600
        if hours < 1 { return "Just now" }
        if hours < 24 { return String(format: "%.0f hour%@ ago", hours, hours < 1.5 ? "" : "s") }
        let days = hours / 24
        if days < 30 { return String(format: "%.0f day%@ ago", days, days < 1.5 ? "" : "s") }
        let months = days / 30
        return String(format: "%.0f month%@ ago", months, months < 1.5 ? "" : "s")
    }

    // MARK: - Friend Activity

    private func friendActivitySection(_ activity: ActivityService.CardActivityResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(detailAccent)

                Text("Friend Activity")
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
            }

            if activity.ownerCount > 0 {
                Text("\(activity.ownerCount) friend\(activity.ownerCount == 1 ? "" : "s") own this card")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.textSecondary)
            }

            if !activity.recent.isEmpty {
                VStack(spacing: 8) {
                    ForEach(activity.recent.prefix(3)) { item in
                        ActivityEventCell(item: item)
                    }
                }
            }
        }
    }

    // MARK: - Condition Price Breakdown

    private var conditionPriceSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Condition Pricing")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)

            VStack(spacing: 0) {
                ForEach(Array(conditionPrices.enumerated()), id: \.element.id) { index, row in
                    HStack {
                        Text(row.conditionLabel)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(row.condition == "nm" ? PA.Colors.text : PA.Colors.muted)
                        Spacer()
                        if let low = row.lowPrice, let high = row.highPrice, low != high {
                            Text(formatConditionPrice(low) + " – " + formatConditionPrice(high))
                                .font(.system(size: 12))
                                .foregroundStyle(PA.Colors.muted)
                                .padding(.trailing, 8)
                        }
                        Text(formatConditionPrice(row.price))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(row.condition == "nm" ? detailAccent : PA.Colors.text)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 16)

                    if index < conditionPrices.count - 1 {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.horizontal, 16)
                    }
                }
            }
            .glassSurface()
        }
    }

    private func formatConditionPrice(_ value: Double) -> String {
        if value >= 1000 { return String(format: "$%.0f", value) }
        return String(format: "$%.2f", value)
    }

    // MARK: - Graded Market Summary

    /// Aggregate market-summary stats for the currently-selected graded
    /// bucket. card_metrics is per (slug, printing, grade) — no provider —
    /// so this section is bucket-level (e.g. "10 Market Summary"), not
    /// per-(provider, bucket). Renders only when graded mode is selected
    /// AND we have a card_metrics row for the active bucket.
    @ViewBuilder
    private var gradedMarketSummarySection: some View {
        if case .graded(_, let bucket) = selectedPriceMode,
           let metric = gradedCardMetricsByBucket[bucket] {
            let rows = buildGradedSummaryRows(metric)
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Market Summary")
                        .font(PA.Typography.sectionTitle)
                        .foregroundStyle(PA.Colors.text)

                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.label) { index, row in
                            HStack {
                                Text(row.label)
                                    .font(.system(size: 14, weight: row.emphasized ? .semibold : .medium))
                                    .foregroundStyle(row.emphasized ? PA.Colors.text : PA.Colors.muted)
                                Spacer()
                                Text(row.value)
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(row.emphasized ? detailAccent : PA.Colors.text)
                            }
                            .padding(.vertical, 10)
                            .padding(.horizontal, 16)

                            if index < rows.count - 1 {
                                Divider()
                                    .background(PA.Colors.border)
                                    .padding(.horizontal, 16)
                            }
                        }
                    }
                    .glassSurface()

                    if let asOf = formatGradedSummaryAsOf(metric.updatedAt) {
                        Text(asOf)
                            .font(.system(size: 11))
                            .foregroundStyle(PA.Colors.muted)
                            .padding(.top, 2)
                    }
                }
            }
        }
    }

    private struct GradedSummaryRow {
        let label: String
        let value: String
        let emphasized: Bool
    }

    private func buildGradedSummaryRows(_ metric: GradedCardMetricRow) -> [GradedSummaryRow] {
        var rows: [GradedSummaryRow] = []
        if let median7d = metric.median7d {
            rows.append(.init(label: "7D Median", value: formatConditionPrice(median7d), emphasized: true))
        }
        if let median30d = metric.median30d {
            rows.append(.init(label: "30D Median", value: formatConditionPrice(median30d), emphasized: false))
        }
        if let low = metric.low30d, let high = metric.high30d {
            rows.append(.init(
                label: "30D Range",
                value: "\(formatConditionPrice(low)) – \(formatConditionPrice(high))",
                emphasized: false
            ))
        }
        if let count = metric.snapshotCount30d {
            rows.append(.init(label: "Sample Size (30D)", value: "\(count) sales", emphasized: false))
        }
        return rows
    }

    private func formatGradedSummaryAsOf(_ updatedAt: String?) -> String? {
        guard let updatedAt, let date = ISO8601DateFormatter().date(from: updatedAt) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return "Updated \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    // MARK: - Finish Variant Selector

    private var finishGroups: [FinishGroup] {
        availablePrintings.toFinishGroups()
    }

    private var activeFinishGroup: FinishGroup? {
        let groups = finishGroups
        if let id = selectedPrintingId,
           let match = groups.first(where: { group in
               group.variants.contains(where: { $0.printingId == id })
           }) {
            return match
        }
        return groups.first
    }

    private var shouldShowFinishPicker: Bool {
        let groups = finishGroups
        if groups.count > 1 { return true }
        if let only = groups.first, only.variants.count > 1 { return true }
        return false
    }

    private var finishPillSection: some View {
        let groups = finishGroups
        let active = activeFinishGroup

        return VStack(alignment: .leading, spacing: 10) {
            Text("Finish")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
                .textCase(.uppercase)

            HStack(spacing: 6) {
                ForEach(groups) { group in
                    let isActive = active?.id == group.id
                    Button {
                        PAHaptics.selection()
                        selectedPrintingId = group.defaultPrintingId
                    } label: {
                        Text(group.finishLabel)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(isActive ? PA.Colors.background : PA.Colors.text)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(isActive ? detailAccent : PA.Colors.surfaceSoft)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }

            if let active, active.variants.count > 1 {
                HStack(spacing: 6) {
                    ForEach(active.variants) { variant in
                        let isActive = selectedPrintingId == variant.printingId
                        Button {
                            PAHaptics.selection()
                            selectedPrintingId = variant.printingId
                        } label: {
                            Text(variant.stampLabel)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(isActive ? PA.Colors.text : PA.Colors.muted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(isActive ? PA.Colors.surfaceSoft : Color.clear)
                                .overlay(
                                    Capsule().stroke(isActive ? detailAccent.opacity(0.4) : PA.Colors.muted.opacity(0.15), lineWidth: 1)
                                )
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.leading, 4)
            }
        }
    }

    // MARK: - Grade Pill Selector

    private var availableAgencies: [String] {
        let agencies = availableGradedOptions.compactMap { mode -> String? in
            if case .graded(let provider, _) = mode { return provider }
            return nil
        }
        var seen = Set<String>()
        return agencies.filter { seen.insert($0).inserted }
    }

    private func bucketsForAgency(_ agency: String) -> [String] {
        let order: [String] = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"]
        let buckets = availableGradedOptions.compactMap { mode -> String? in
            if case .graded(let provider, let bucket) = mode, provider == agency { return bucket }
            return nil
        }
        var seen = Set<String>()
        let unique = buckets.filter { seen.insert($0).inserted }
        return unique.sorted { (order.firstIndex(of: $0) ?? 99) < (order.firstIndex(of: $1) ?? 99) }
    }

    private func gradeDisplayLabel(_ bucket: String) -> String {
        switch bucket {
        case "LE_7": return "7 or less"
        case "G8": return "8"
        case "G9": return "9"
        case "G9_5": return "9.5"
        case "G10": return "10"
        case "G10_PERFECT": return "10 Perfect"
        default: return bucket
        }
    }

    private var gradePillSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Row 1: Near Mint / Graded toggle
            HStack(spacing: 8) {
                gradePill(title: "Near Mint", selected: selectedPriceMode == .nearMint) {
                    PAHaptics.selection()
                    selectedPriceMode = .nearMint
                    gradedHeroPrice = nil
                    printingHeroPrice = nil
                }
                gradePill(title: "Graded", selected: selectedPriceMode.isGraded) {
                    PAHaptics.selection()
                    applyGradedSelection()
                }
            }

            if selectedPriceMode.isGraded && !availableGradedOptions.isEmpty {
                // Row 2: Grading agency pills
                HStack(spacing: 6) {
                    ForEach(availableAgencies, id: \.self) { agency in
                        Button {
                            PAHaptics.selection()
                            selectedGradingAgency = agency
                            // Pick highest available grade for this agency
                            let buckets = bucketsForAgency(agency)
                            selectedGradeBucket = buckets.last ?? "G10"
                            applyGradedSelection()
                        } label: {
                            Text(agency)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(selectedGradingAgency == agency ? PA.Colors.background : PA.Colors.text)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 7)
                                .background(selectedGradingAgency == agency ? detailAccent : PA.Colors.surfaceSoft)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }

                // Row 3: Grade picker wheel
                let buckets = bucketsForAgency(selectedGradingAgency)
                if buckets.count > 1 {
                    HStack(spacing: 0) {
                        Text("Grade")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(PA.Colors.muted)
                            .padding(.leading, 4)

                        Picker("Grade", selection: $selectedGradeBucket) {
                            ForEach(buckets, id: \.self) { bucket in
                                Text(gradeDisplayLabel(bucket))
                                    .tag(bucket)
                            }
                        }
                        .pickerStyle(.wheel)
                        .frame(height: 100)
                        .clipped()
                        .onChange(of: selectedGradeBucket) {
                            PAHaptics.selection()
                            applyGradedSelection()
                        }
                    }
                    .padding(8)
                    .glassSurface()
                } else if let only = buckets.first {
                    HStack(spacing: 6) {
                        Text("Grade")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(PA.Colors.muted)
                        Text(gradeDisplayLabel(only))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                    }
                    .padding(.leading, 4)
                }
            }

            if selectedPriceMode.isGraded && availableGradedOptions.isEmpty && gradedMetricsLoaded {
                Text("No graded data available for this card")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .padding(.horizontal, 0)
    }

    private func applyGradedSelection() {
        let target = PriceMode.graded(provider: selectedGradingAgency, bucket: selectedGradeBucket)
        if availableGradedOptions.contains(target) {
            selectedPriceMode = target
        } else if let first = availableGradedOptions.first(where: {
            if case .graded(let p, _) = $0 { return p == selectedGradingAgency }
            return false
        }) {
            selectedPriceMode = first
            if case .graded(_, let bucket) = first { selectedGradeBucket = bucket }
        } else if let first = availableGradedOptions.first {
            selectedPriceMode = first
            if case .graded(let p, let b) = first {
                selectedGradingAgency = p
                selectedGradeBucket = b
            }
        } else {
            selectedPriceMode = .graded(provider: selectedGradingAgency, bucket: selectedGradeBucket)
        }
    }

    private func gradePill(title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(selected ? PA.Colors.background : PA.Colors.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(selected ? detailAccent : PA.Colors.surfaceSoft)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Grade-Aware Hero Price

    private var currentHeroPrice: String {
        switch selectedPriceMode {
        case .nearMint:
            // JP cards: prefer the Yahoo! Auctions JP scraped median
            // (real JP-market sold price) over Scrydex (US-market).
            // Falls back to printing-specific override → MarketCard's
            // headline price (Scrydex) when no JP data is present.
            if let usd = preferredHeroPrice {
                if usd <= abundantRawCardMaxUsd { return abundantRawCardHeroLabel }
                if usd >= 1000 { return String(format: "$%.0f", usd) }
                return String(format: "$%.2f", usd)
            }
            return "—"
        case .graded:
            guard let price = gradedHeroPrice, price > 0 else { return "—" }
            if price >= 1000 { return String(format: "$%.0f", price) }
            return String(format: "$%.2f", price)
        }
    }


    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Spacer()
            Text(value)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.textSecondary)
        }
    }

    private func formatMedian7d(_ value: Double?) -> String {
        guard let value, value > 0 else { return "—" }
        return value.formatted(.currency(code: "USD"))
    }
}

// MARK: - Supporting Types

enum DetailTone {
    case neutral, accent, positive, negative, muted

    var color: Color {
        switch self {
        case .neutral: return PA.Colors.text
        // .accent maps to the global brand accent — DetailTone is a
        // generic semantic-tone enum used by helper subviews that don't
        // know which card they're rendering. JP-aware accent recoloring
        // is applied directly at the call sites inside CardDetailView
        // via `detailAccent`, not through this enum.
        case .accent: return PA.Colors.accent
        case .positive: return PA.Colors.positive
        case .negative: return PA.Colors.negative
        case .muted: return PA.Colors.muted
        }
    }
}

fileprivate extension MarketCard {
    var asSearchResult: SearchCardResult {
        SearchCardResult(
            canonicalSlug: id,
            canonicalName: name,
            setName: setName,
            cardNumber: cardNumber,
            year: nil,
            primaryImageUrl: imageURL?.absoluteString,
            score: nil
        )
    }
}
