import SwiftUI
import NukeUI
import OSLog

private let abundantRawCardMaxUsd: Double = 2
private let abundantRawCardDetailLabel = "Low-dollar card"

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
    latestPrice: Double?,
    marketPrice: Double?,
    jpLatestPrice: Double?,
    activeCardPrice: Double,
    chartFallbackPrice: Double?,
    yahooJpPrice: Double?,
    yahooJpSampleCount: Int?,
    snkrdunkPrice: Double?,
    snkrdunkSampleCount: Int?
) -> Double? {
    if isJapaneseCard {
        // JP hero = the blended Snkrdunk+Yahoo freshest trusted sold point
        // (jp_latest_price, sample_count>=3). This supersedes the per-source
        // sample-count pick, which could surface a stale Yahoo observation
        // (e.g. $0.20 while Snkrdunk shows $31). Fall back to the per-source
        // pick only when no fresh blended point exists yet.
        if let jpLatestPrice, jpLatestPrice > 0 { return jpLatestPrice }
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
    // EN-RAW hero = the freshest snapshot point (latest_price). The view
    // already guards it (null when suppressed) and falls back to the median
    // basis, so this is the freshest when we have one, else the 3-day median.
    if let latestPrice, latestPrice > 0 { return latestPrice }
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
    /// Opens eBay listing URLs in the user's browser (section 12).
    @Environment(\.openURL) private var openURL
    /// Light mode drops the ambient accent glow behind the card art
    /// (owner: keep the clean drop shadow, lose the blue bloom).
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var premiumGate = PremiumGate.shared
    @State private var showCorrectionSheet = false
    @State private var showMarketSummaryPaywall = false
    /// Slugs for which we've already fired market_brief_viewed, so the analytics
    /// event fires once per card (re-fires on an in-place EN↔JP slug swap) but
    /// not again when the brief scrolls back into view.
    @State private var loggedBriefSlugs: Set<String> = []
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
    @State private var selectedTimeframe: ChartTimeframe = .month
    @State private var chartPrices: [Double] = []
    @State private var chartTimestamps: [String] = []
    @State private var chartLoading = false
    @State private var chartError: String?
    @State private var cardProfile: CardProfileResult?
    @State private var cardMetrics: CardMetricsResult?
    /// Prefetched price metrics for the EN/JP paired slug so tapping the
    /// language toggle shows the partner's hero price instantly instead of
    /// waiting on a fresh fetch. Consumed on swap only when the prefetched
    /// slug matches the target; re-primed for the new partner after each swap.
    @State private var preloadedPairedMetrics: (slug: String, metrics: CardMetricsResult)?
    /// The canonical (card-level) metrics, captured on load and never replaced by
    /// the per-printing price takeover. The hero change badge reads this so the
    /// detail's 24h/7d move always matches the homepage — the per-printing change
    /// is frequently unpopulated and would otherwise blank the badge to "--".
    @State private var canonicalMetrics: CardMetricsResult?
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
    /// Per-(grader, grade) market summary, keyed "GRADER::bucket" (e.g.
    /// "PSA::G10") so PSA 10 ≠ CGC 10 ≠ TAG 10. Sourced from
    /// public_graded_variant_prices via fetchGradedCardMetrics; the headline
    /// is marketPrice (14-day median). One dominant printing is resolved per
    /// (grader, grade) — see the tie-break in the loader (#192 grader-split).
    @State private var gradedCardMetricsByBucket: [String: GradedCardMetricRow] = [:]
    /// Per-bucket price history for the active grader. Graded mode's
    /// chart is ALWAYS this blended grade ladder (≥2 chartable buckets;
    /// single-bucket cards fall back to the plain line). Absolute
    /// dollars by default — the chart reads as the market's actual
    /// grade ladder; the %/$ toggle flips to indexed momentum across
    /// the PSA 10 → PSA 7 price gap.
    @State private var gradePerfSeries: [GradePerfDatum] = []
    @State private var gradePerfScale: MultiSeriesChartModel.Scale = .absolute
    /// RAW variant overlay — every printing (finishes + editions + stamps)
    /// charted together; the finish pills set selectedPrintingId, which
    /// isolates one line (nil = All → normalized overlay of every finish).
    @State private var variantSeries: [VariantSeriesDatum] = []
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

    // MARK: - Live eBay listings + bug report state

    /// Lazy-loaded live listings from /api/ebay/browse (the same route
    /// the web card page uses). Fetched once when the section first
    /// appears; failures collapse the section to a quiet retry row
    /// rather than blocking the page.
    private enum EbayLoadState { case idle, loading, loaded, failed }
    @State private var ebayLoadState: EbayLoadState = .idle
    @State private var ebayListings: [EbayListing] = []
    @State private var ebayTotalAsks: Int = 0
    /// Card id the current listings belong to — lets reappear skip the
    /// refetch while a language-toggle (new id, same view) reloads.
    @State private var ebayLoadedCardId: String? = nil

    /// Bug-report flow: category dialog → optional note alert → PostHog.
    @State private var showBugCategoryDialog = false
    @State private var bugNoteText = ""
    @State private var pendingBugCategory: BugReportCategory? = nil
    @State private var showBugNoteAlert = false
    @State private var bugReportSubmitted = false

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
            latestPrice: cardMetrics?.latestPrice,
            marketPrice: cardMetrics?.marketPrice,
            jpLatestPrice: cardMetrics?.jpLatestPrice,
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

    /// The 3-day median shown directly below the freshest hero price for
    /// EN-RAW cards. The hero (above) is the freshest daily point; this is the
    /// steadier 3-day median that the newest point already folds into — two
    /// distinct values, one per line, neither competing for the hero spot.
    /// Because cardMetrics becomes the per-printing row once a finish is
    /// selected, both track the chosen finish. JP renders its own 14-day
    /// median (or low-sample observation count); nil for graded mode
    /// (separate path), low-dollar EN cards, and when no median is available.
    private var medianSublineText: String? {
        // Graded mode first, for EVERY language: the graded hero comes from
        // the graded metric rows (a separate fetch), so any RAW-basis median
        // below it would be a basis mismatch in the subline. No graded
        // subline exists today — show none rather than a wrong-basis one.
        guard !selectedPriceMode.isGraded else { return nil }
        // JP: the blended 14-day median (jp_display_price) sits under the freshest
        // hero (jp_latest_price). JP sold data is ~weekly, so the window is 14d
        // (not the EN 3d). nil when the card has no qualifying JP series.
        if isJapaneseCard {
            guard let median = cardMetrics?.jpDisplayPrice, median > 0 else { return nil }
            // Thin tier (server PR #248): rows whose 14d window held only
            // 1-2-sample observations still display (confidence 30 /
            // JP_LOW_SAMPLE, changes hard-nulled server-side), but calling
            // a 1-2-point basis a "median" would overstate it. State the
            // observation count instead — "observed", not "sold on", because
            // observation time ≠ sale time. The server writes the count for
            // every displayed row, so a nil count here (stale pre-#248 cache)
            // safely keeps the trusted wording for what was a trusted-only
            // population. >= 3 rows are bit-identical to before.
            if let samples = cardMetrics?.jpDisplaySampleCount, samples < 3 {
                let noun = samples == 1 ? "sale" : "sales"
                return "Based on \(samples) \(noun) observed in the last 14 days"
            }
            let f = median >= 1000 ? String(format: "$%.0f", median) : String(format: "$%.2f", median)
            return "14-day median: \(f)"
        }
        guard !isAbundantNearMintHeroPrice else { return nil }
        guard let median = cardMetrics?.marketPrice, median > 0 else { return nil }
        let formatted = median >= 1000 ? String(format: "$%.0f", median) : String(format: "$%.2f", median)
        return "3-day median: \(formatted)"
    }

    /// Source label shown next to the hero price so the user knows
    /// which provider the number came from. Matches the confidence-pick
    /// winner from preferredHeroPrice. Affects only the inline hint,
    /// not the top-level pricing structure.
    private var heroPriceSourceLabel: String? {
        if isJapaneseCard {
            // When the hero is the blended freshest (jp_latest_price), it isn't
            // attributable to one source (could be Snkrdunk or Yahoo, whichever
            // sold most recently) — label it neutrally rather than risk naming
            // the wrong source. Only the per-source fallback names a provider.
            if let jp = cardMetrics?.jpLatestPrice, jp > 0 { return "JP sold listings" }
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

    /// heroPriceSourceLabel plus the age of the observation behind the
    /// hero price — "JP sold listings · 5 hours ago". The as-of column
    /// matches whichever value the hero selected: the blended
    /// jp_latest_price carries its own timestamp; the per-source
    /// fallback uses that source's observed_at. Falls back to the bare
    /// label when no timestamp is available rather than hiding the
    /// source attribution.
    private var heroPriceSourceSubline: String? {
        // Graded mode swaps the hero to the graded ladder price — a raw
        // JP-feed attribution under it would mislabel the number.
        guard !selectedPriceMode.isGraded, let label = heroPriceSourceLabel else { return nil }
        let asOf: String?
        if let jp = cardMetrics?.jpLatestPrice, jp > 0 {
            asOf = cardMetrics?.jpLatestPriceAsOf
        } else {
            let pick = selectJpPriceSource(
                yahooJpPrice: cardMetrics?.yahooJpPrice,
                yahooJpSampleCount: cardMetrics?.yahooJpSampleCount,
                snkrdunkPrice: cardMetrics?.snkrdunkPrice,
                snkrdunkSampleCount: cardMetrics?.snkrdunkSampleCount
            )
            switch pick.source {
            case .yahooJp: asOf = cardMetrics?.yahooJpObservedAt
            case .snkrdunk: asOf = cardMetrics?.snkrdunkObservedAt
            default: asOf = nil
            }
        }
        guard let asOf else { return label }
        return "\(label) · \(formatYahooJpObservedAt(asOf))"
    }

    // MARK: - Minimized-tab-bar FAB tracking

    /// Mirrors the iOS 26 Liquid Glass tab bar's minimize state. The bar
    /// shrinks into the bottom-leading pill on scroll-down but never
    /// releases its safe-area inset, so without this the FAB stack keeps
    /// hovering at full-bar height beside a corner-hugging pill — visibly
    /// uneven (owner report 2026-06-12). iOS 26.3 ships no public "is the
    /// bar minimized" signal (the SDK has only the tabBarMinimizeBehavior
    /// setter), so TabBarMinimizeMirror (bottom of file) reproduces the
    /// system's observed triggers — ~110pt of downward travel to
    /// minimize; back-at-top or a presentation to re-expand — and
    /// resets for the presentations we own. Unobservable re-expansions
    /// (ShareLink's sheet, tapping the pill itself) desync until the
    /// next top/presentation.
    @State private var tabBarLikelyMinimized = false

    /// True while any presentation this view owns is up. The system
    /// re-expands the minimized bar when a presentation appears, so the
    /// mirror resets on this flipping true — otherwise the FAB stack
    /// would sit low over an expanded bar after the dismissal. Computed
    /// here (not inline in body) to keep body's expression cheap for
    /// the type-checker.
    private var ownedPresentationActive: Bool {
        showBugCategoryDialog
            || showBugNoteAlert
            || showCorrectionSheet
            || showSignInPromptForAdd
            || autoAddError != nil
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
                // reads as JP-themed at a glance. Dark mode only: on light
                // chrome the bloom read as a blue smear behind the card
                // (owner feedback 2026-06-11); the neutral drop shadows
                // carry the depth there.
                if colorScheme == .dark {
                    Ellipse()
                        .fill(detailAccent)
                        .opacity(0.25)
                        .blur(radius: 120)
                        .frame(width: 380, height: 500)
                        .offset(y: 180)
                        .allowsHitTesting(false)
                }
            }
        }
        .coordinateSpace(name: "scroll")
        // No scroll-edge band under the nav buttons: iOS 26's default
        // top scroll-edge effect rendered as a hard white bar across
        // the status/toolbar area in light mode once content scrolled
        // under it (owner report 2026-06-12). The back/share buttons
        // carry their own Liquid Glass capsules, so they stay legible
        // over content without the band.
        // The band had a SECOND source beyond the scroll-edge effect:
        // the navigation bar's own background appearance (this screen
        // uses real ToolbarItems for back/share, so a bar exists, and
        // the system paints its background once content scrolls under
        // it — the white bar persisted on device, build 20260618).
        // The modifier hides both layers, iOS 26 only.
        .modifier(HideTopScrollEdgeEffect())
        .modifier(TabBarMinimizeMirror(
            minimized: $tabBarLikelyMinimized,
            presentationActive: ownedPresentationActive
        ))
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
            // Ride down into the corner the minimized bar vacates so the
            // "+" centers level with the bottom-leading pill; back up
            // when the bar re-expands. 75pt is measured, not eyeballed
            // (pixel scan, iPhone 17 Pro Max / iOS 26.3): the resting
            // "+" center sits 20 (padding) + 83 (tab bar + home-
            // indicator safe area) + 24 (radius) = 127pt above the
            // physical bottom; the minimized pill centers ~52pt up.
            // Both are safe-area-anchored constants on Dynamic-Island
            // devices, so the 75pt delta is device-independent there.
            // Spring tuned to track the system bar's minimize: the
            // first cut (response 0.35 / damping 0.85) read as "the +
            // is a little slow compared to the navigation bar" on
            // device (owner, build 20260618) — the system's own bar
            // animation is snappier and settles with less bounce.
            .offset(y: tabBarLikelyMinimized ? 75 : 0)
            .animation(.spring(response: 0.26, dampingFraction: 0.9), value: tabBarLikelyMinimized)
        }
        .overlay(alignment: .top) {
            if showAddedBanner {
                addedToPortfolioBanner
            }
        }
        // Outermost on purpose so the scroll viewport AND the floating
        // buttons opt out together. No inline text input exists on this
        // screen (the bug-report TextField lives in a system alert
        // window), so nothing here should ever keyboard-avoid. Without
        // this, a keyboard summoned mid-flow — e.g. the share-to-
        // iMessage compose — inset the bottom safe area by ~⅓ screen,
        // floating the FABs to mid-screen and, when the inset failed to
        // clear on return from the share sheet, leaving a giant dead
        // void under the last section (owner report 2026-06-12).
        .ignoresSafeArea(.keyboard)
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
        // Grade Performance overlay: per-bucket history for the active grader.
        // Keyed so it refires on grader / timeframe / printing / availability
        // changes, mirroring the main chart's task.
        .task(id: "gradePerf|\(activeCard.id)|\(selectedTimeframe.rawValue)|\(selectedPriceMode)|\(selectedPrintingId ?? "")|\(availableGradedOptions.count)") {
            await loadGradePerformance()
        }
        // RAW variant overlay: fetch each comparable variant's history.
        .task(id: "variant|\(activeCard.id)|\(selectedTimeframe.rawValue)|\(selectedPriceMode)|\(selectedPrintingId ?? "")|\(availablePrintings.count)") {
            await loadVariantOverlay()
        }
        // Keyed by activeCard.id so the entire data-load fan-out re-fires
        // when the user taps the EN/JP toggle and we swap activeCard.
        // Without the id, SwiftUI runs the task only on first appearance
        // and the toggled view would stay frozen on the original slug's
        // data.
        .task(id: activeCard.id) {
            // Capture the slug this task was started for. Every state
            // write below re-checks it against the live activeCard.id:
            // .task(id:) cancels the old task on an EN/JP swap, but a
            // response that already resumed (or a cancellation error
            // landing in a catch) could otherwise write the OLD card's
            // data over the NEW card's primed state.
            let slug = activeCard.id
            // Cross-language pairing lookup. Hits /api/cards/[slug]/detail
            // which now carries canonical.pairedSlug + pairedLanguage. A
            // failed fetch (table missing, network blip) leaves the
            // toggle hidden — degrades silently.
            let pairing: CardPairing? = try? await CardService.shared.fetchCardPairing(slug: slug)
            await MainActor.run {
                guard activeCard.id == slug else { return }
                pairedSlug = pairing?.pairedSlug
                pairedLanguage = pairing?.pairedLang
                pairedImageUrl = pairing?.pairedImageUrl
            }
            // Preload the paired (EN↔JP) card's price metrics in the background
            // so tapping the language toggle is instant. Fire-and-forget; the
            // swap consumes this only when the prefetched slug matches the
            // target, so a stale prefetch is harmless.
            if let partner = pairing?.pairedSlug {
                Task {
                    if let m = try? await CardService.shared.fetchCardMetrics(slug: partner) {
                        await MainActor.run { preloadedPairedMetrics = (partner, m) }
                    }
                }
            }

            // Always fetch the (cron-generated, cached) profile so the
            // locked state can blur the REAL summary rather than a generic
            // placeholder. recordAnalysisReveal runs BEFORE assigning so the
            // render sees the card as already-unlocked (no clear→blur flash
            // on the 3rd reveal); it no-ops for Pro, already-unlocked cards,
            // and once the free limit is hit — those render behind the blur.
            let fetchedProfile = try? await CardService.shared.fetchCardProfile(slug: slug)
            guard activeCard.id == slug else { return }
            if fetchedProfile != nil { premiumGate.recordAnalysisReveal(slug: slug) }
            cardProfile = fetchedProfile
            do {
                let metrics = try await CardService.shared.fetchCardMetrics(slug: slug)
                guard activeCard.id == slug else { return }
                cardMetrics = metrics
                canonicalMetrics = metrics
            } catch {
                // A cancelled fetch means the user already swapped cards —
                // the new slug's task owns the state now; clobbering it
                // with nil here would blank the price it just primed.
                guard activeCard.id == slug, !Task.isCancelled else { return }
                // Preserve the prior fallback (nil → cached activeCard.price,
                // which is last-known-trusted, not garbage) but don't let a
                // price-fetch failure masquerade as a healthy load — log it.
                cardMetrics = nil
                Logger.api.debug("card metrics fetch failed slug=\(slug, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
            // First metrics arrival is the cue to drop the toggle fade.
            // Cleared here rather than in the toggle tap so the fade
            // outlasts profile fetch latency (~100–400ms) and reads as
            // intentional motion instead of a flash.
            await MainActor.run { togglingLanguage = false }
            if AuthService.shared.isAuthenticated {
                let activity = try? await ActivityService.shared.fetchCardActivity(slug: slug)
                guard activeCard.id == slug else { return }
                friendActivity = activity
            }
            // Fire a card_view personalization event once per appearance.
            await PersonalizationService.shared.track(
                PersonalizedEvent(
                    type: .cardView,
                    canonicalSlug: slug,
                    variantRef: selectedPrintingId.map { "\($0)::RAW" }
                )
            )
            // Load every printing (finishes + editions + stamps) for the chart's
            // finish pills.
            if let printings = try? await CardService.shared.fetchPrintings(slug: slug) {
                // selectedPrintingId stays nil by default → the chart shows the
                // all-finish overlay and the headline reads the canonical
                // (preferred-printing) price. Tapping a finish pill on the chart
                // selects that printing.
                await MainActor.run {
                    guard activeCard.id == slug else { return }
                    availablePrintings = printings
                }
            }
            // Load condition-based prices
            if let prices = try? await CardService.shared.fetchConditionPrices(
                slug: slug,
                printingId: selectedPrintingId
            ) {
                await MainActor.run {
                    guard activeCard.id == slug else { return }
                    conditionPrices = prices
                }
            }
            // Per-(grader, bucket) graded market summary. public_graded_variant_prices
            // is per (printing, grader, grade), so key by "GRADER::bucket" — the agency
            // pills (PSA/CGC/BGS/TAG) then map to distinct rows. For a slug with several
            // printings of one grader+grade, pick the dominant printing: prefer a usable
            // 14d market_price, then most snapshot_count_30d, then freshest, then
            // printing_id (mirrors the web ladder's tie-break so the pick is stable).
            // No canonical printing_id=NULL row exists in this view.
            if let rows = try? await CardService.shared.fetchGradedCardMetrics(slug: slug) {
                var grouped: [String: [GradedCardMetricRow]] = [:]
                for row in rows {
                    grouped["\(row.grader)::\(row.grade)", default: []].append(row)
                }
                var resolved: [String: GradedCardMetricRow] = [:]
                for (key, candidates) in grouped {
                    let best = candidates.max { a, b in
                        let aHas = a.marketPrice != nil, bHas = b.marketPrice != nil
                        if aHas != bHas { return !aHas }
                        let aN = a.snapshotCount30d ?? -1, bN = b.snapshotCount30d ?? -1
                        if aN != bN { return aN < bN }
                        let aAsOf = a.marketPriceAsOf ?? a.latestPriceAsOf ?? "", bAsOf = b.marketPriceAsOf ?? b.latestPriceAsOf ?? ""
                        if aAsOf != bAsOf { return aAsOf < bAsOf }
                        return (a.printingId ?? "") > (b.printingId ?? "")
                    }
                    if let best { resolved[key] = best }
                }
                await MainActor.run {
                    guard activeCard.id == slug else { return }
                    gradedCardMetricsByBucket = resolved
                }
            }
            // Load available graded options lazily
            if let rows = try? await CardService.shared.fetchGradedVariantMetrics(slug: slug) {
                let validProviders: Set<String> = ["PSA", "CGC", "BGS", "TAG"]
                let validBuckets: Set<String> = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"]
                let options = rows
                    .filter { validProviders.contains($0.provider) && validBuckets.contains($0.grade) }
                    .filter { ($0.historyPoints30D ?? 0) >= 3 || $0.providerAsOfTs != nil }
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
                    guard activeCard.id == slug else { return }
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
            // This Task is unstructured — unlike .task(id:), nothing
            // cancels it when the user swaps EN/JP mid-flight. Capture
            // the (slug, printing) pair it was started for and discard
            // the response if either moved on, so a finish-pill tap
            // followed by a quick language toggle can't land the OLD
            // card's per-printing price on the NEW card's hero.
            let slug = activeCard.id
            let printing = selectedPrintingId
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
                    slug: slug,
                    printingId: printing
                ), metrics.marketPrice != nil {
                    // Hero follows the selected finish. Since migration
                    // 20260601120000 every per-printing RAW row carries the
                    // same freshest + 3-day-median basis as the canonical row
                    // (its own finish's snapshot series), so a per-printing
                    // takeover now shows that finish's real price — not the
                    // stale raw scrydex basis that used to drop the hero below
                    // the homepage. Gate only on a non-null market_price so a
                    // suppressed/quarantined finish keeps the prior hero
                    // instead of blanking it. For the preferred (default)
                    // printing the per-printing series IS the canonical series,
                    // so the initial load matches the homepage with no flicker.
                    await MainActor.run {
                        guard activeCard.id == slug, selectedPrintingId == printing else { return }
                        cardMetrics = metrics
                    }
                }
                if let prices = try? await CardService.shared.fetchConditionPrices(
                    slug: slug,
                    printingId: printing
                ) {
                    await MainActor.run {
                        guard activeCard.id == slug, selectedPrintingId == printing else { return }
                        conditionPrices = prices
                    }
                }
            }
        }
        .onChange(of: premiumGate.isPro) { _, _ in
            // Unstructured like the printing handler above — pin the
            // slug so a profile fetched for the pre-toggle card can't
            // land on the post-toggle one.
            let slug = activeCard.id
            Task {
                let fetchedProfile = try? await CardService.shared.fetchCardProfile(slug: slug)
                guard activeCard.id == slug else { return }
                if fetchedProfile != nil { premiumGate.recordAnalysisReveal(slug: slug) }
                cardProfile = fetchedProfile
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
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        // No custom circle background: iOS 26 wraps toolbar
                        // buttons in its own Liquid Glass capsule, so a custom
                        // .ultraThinMaterial circle doubled up ("circle inside a
                        // circle"). Let the system provide the chrome; keep a
                        // 44pt tap target so it stays easy to hit.
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
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
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(PA.Colors.text)
                                // Same as the back button: no custom circle —
                                // iOS 26 supplies the glass capsule, so the
                                // custom one doubled up.
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
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
        // If we prefetched the target's price metrics, prime them so the hero
        // price is instant; otherwise nil and the .task refetch fills it in.
        cardMetrics = preloadedPairedMetrics?.slug == targetSlug ? preloadedPairedMetrics?.metrics : nil
        canonicalMetrics = cardMetrics
        preloadedPairedMetrics = nil
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

            // 7. Chart section — supporting evidence after the read. In
            //    graded mode the chart carries the grade pills + "All"
            //    overlay (the old separate Grade Performance section was
            //    folded into the main chart, 2026-06-11).
            chartSection

            // 8. Personalized insight ("How this fits your style") — secondary
            // differentiated layer; renders its own fallback when signal is thin.
            PersonalizedInsightCardView(
                canonicalSlug: activeCard.id,
                variantRef: selectedPrintingId.map { "\($0)::RAW" },
                cardName: activeCard.name
            )

            // 9. Details grid — metadata break after the narrative sections.
            detailsGrid
                .padding(.top, 8)

            // 9b. JP per-source breakdown — its own metadata panel (moved out
            // of the hero), so the price area stays focused on the single
            // blended read while the unblended sources sit with the metadata.
            jpSourcesPanel

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

            // 12. Live eBay listings — real asks, affiliate-decorated
            //     server-side once EBAY_EPN_CAMPAIGN_ID is configured.
            ebayListingsSection

            // 13. Report-a-bug — last on purpose: a user who scrolled
            //     everything and still sees something wrong lands here.
            bugReportSection
        }
        .padding(PA.Layout.sectionPadding)
    }

    /// Explanation shown in place of a value when the canonical EN-RAW price is
    /// suppressed because our two market sources (PriceCharting + Scrydex)
    /// disagree beyond the trust threshold (market_blend_policy ==
    /// "POPALPHA_MARKET_QUARANTINED"). We deliberately show no headline for these
    /// — asserting either source would imply a confidence we don't have — so this
    /// tells the user WHY the price is blank rather than leaving a bare dash.
    /// Gated on the hero actually being blank ("—") so it auto-hides the moment a
    /// graded/JP variant with a real price is selected.
    private var divergedPriceNote: String? {
        // EN-RAW canonical only — the QUARANTINED policy describes the raw
        // PriceCharting-vs-Scrydex divergence, not a graded or JP variant. In
        // graded mode a missing graded price also renders "—", so gate out
        // non-raw modes (and JP) to avoid attaching the note to the wrong price.
        guard !selectedPriceMode.isGraded,
              !isJapaneseCard,
              currentHeroPrice == "—",
              cardMetrics?.marketBlendPolicy == "POPALPHA_MARKET_QUARANTINED"
        else { return nil }
        return "Our market sources disagree too much to give a confident price — some independent research may be required."
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

            // Market price hero row. The EN/JP language toggle (when a
            // card_translations pairing exists) sits trailing on this row —
            // across from the price — instead of on its own line above. The
            // outer HStack centers the toggle against the price; the inner
            // HStack keeps the price + change badge baseline-aligned.
            HStack(alignment: .center) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(currentHeroPrice)
                        .font(PA.Typography.heroPrice)
                        .foregroundStyle(PA.Colors.text)

                    // Suppress the change badge when the hero price is
                    // sourced from Yahoo! JP — change_pct_24h/7d track the
                    // Scrydex market_price, not the Yahoo!-derived median,
                    // so showing a Scrydex delta next to a Yahoo! price
                    // would imply causality that doesn't exist.
                    if !selectedPriceMode.isGraded && !isAbundantNearMintHeroPrice {
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

                // EN/JP language toggle — across from the market price. Renders
                // only when card_translations has a pairing (absent for the
                // ~60–80% of cards without a JP/EN counterpart).
                if let partnerSlug = pairedSlug, pairedLanguage != nil {
                    Spacer(minLength: 8)
                    languageToggleControl(partnerSlug: partnerSlug)
                }
            }

            // 3-day median, directly below the freshest hero. Shown for EN-RAW
            // (and the selected finish) so the user sees live-vs-trend without
            // two numbers fighting for the hero spot.
            if let medianText = medianSublineText {
                Text(medianText)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .accessibilityLabel(medianText)
            }

            // JP source + observation age, directly under the hero. JP sold
            // data lands hourly-to-weekly; without the age a day-old price
            // reads as live.
            if let sourceLine = heroPriceSourceSubline {
                Text(sourceLine)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .accessibilityLabel("Price source: \(sourceLine)")
            }

            if isAbundantNearMintHeroPrice {
                Text(abundantRawCardDetailLabel)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .accessibilityLabel("Low-dollar card")
            }

            // Diverged-price note: PriceCharting + Scrydex conflict beyond the
            // trust threshold, so the headline is intentionally blank. Explain it.
            if let divergedPriceNote {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                        .accessibilityHidden(true)
                    Text(divergedPriceNote)
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 2)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(divergedPriceNote)
            }

            // (JP per-source breakdown moved out of the hero into its own
            // bottom metadata panel — see `jpSourcesPanel`. The hero keeps just
            // the single blended JP read so the price area stays focused.)
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
        // The change badge reflects the CARD-LEVEL move — the canonical row, the
        // same value the homepage shows. cardMetrics may have been taken over by
        // the selected printing (for the per-finish price), whose change is often
        // unpopulated and would blank the badge or diverge from the homepage.
        let changeSource = canonicalMetrics ?? cardMetrics
        if let metrics = changeSource, let m24 = metrics.changePct24H {
            pct = m24; window = "24H"
        } else if let metrics = changeSource, let m7 = metrics.changePct7D {
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

            // Variant select pills — RAW mode. Shown whenever the card has ≥2
            // selectable printings (or one is selected, so "All" stays reachable).
            // Pills cover every selectable finish — not just the chartable ones —
            // so a finish with no/sparse history is still pickable for the headline
            // price. "All" overlays the chartable finishes on a normalized scale;
            // tapping a pill isolates that line (when it has one) + sets the price.
            if !selectedPriceMode.isGraded, availablePrintings.count > 1 || selectedPrintingId != nil {
                variantSelectPills
            }

            // Grade pills — GRADED mode's mirror of the finish pills, and
            // the only grade selector (the picker wheel is gone). Keyed to
            // selectable buckets, not chartable ones, so a grade with
            // sparse history is still pickable for the headline price.
            if selectedPriceMode.isGraded, bucketsForAgency(selectedGradingAgency).count > 1 {
                gradeSelectPills
            }

            // Interactive chart
            ZStack {
                chartContent
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

    // MARK: - Grade Performance (multi-grade overlay)

    private struct GradePerfDatum: Identifiable {
        let id: String        // grade bucket (e.g. "G10")
        let label: String
        let color: Color
        let points: [PricePoint]
    }

    private static let gradePerfOrder = ["G10_PERFECT", "G10", "G9_5", "G9", "G8", "LE_7"]

    /// Grade colors follow the standard loot-rarity ladder so the chart
    /// ranks itself at a glance: a perfect 10 is mythic red, a 10 is
    /// legendary gold, then epic purple → rare blue → uncommon green →
    /// common gray as the grade descends.
    private func gradePerfColor(_ bucket: String) -> Color {
        switch bucket {
        case "G10_PERFECT": return Color(red: 0.937, green: 0.267, blue: 0.267)   // mythic red
        case "G10":         return Color(red: 1.000, green: 0.800, blue: 0.149)   // legendary gold
        case "G9_5":        return Color(red: 0.659, green: 0.333, blue: 0.969)   // epic purple
        case "G9":          return Color(red: 0.231, green: 0.510, blue: 0.965)   // rare blue
        case "G8":          return Color(red: 0.133, green: 0.773, blue: 0.369)   // uncommon green
        case "LE_7":        return PA.Colors.neutral                              // common gray
        default:            return PA.Colors.neutral
        }
    }

    private func gradePerfLabel(_ bucket: String) -> String {
        switch bucket {
        case "G10_PERFECT": return "10 Perfect"
        case "G10":         return "10"
        case "G9_5":        return "9.5"
        case "G9":          return "9"
        case "G8":          return "8"
        case "LE_7":        return "7 or less"
        default:            return bucket
        }
    }

    /// The currently isolated grade bucket (nil when not in graded mode).
    private var activeGradeBucket: String? {
        if case let .graded(_, bucket) = selectedPriceMode { return bucket }
        return nil
    }

    /// Grade select pills — the GRADED-mode mirror of the finish pills,
    /// and the only grade selector (the old picker wheel is gone). The
    /// chart itself stays the blended grade ladder; a pill picks which
    /// grade drives the headline price and metrics, shown by its
    /// loot-rarity dot. Pills cover every selectable bucket — not just
    /// the chartable ones — so a grade with sparse history is still
    /// pickable for the price. The $/% toggle rides the row whenever
    /// the ladder is charted.
    private var gradeSelectPills: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(bucketsForAgency(selectedGradingAgency), id: \.self) { bucket in
                        variantPill(
                            gradePerfLabel(bucket),
                            isActive: activeGradeBucket == bucket,
                            dot: gradePerfColor(bucket)
                        ) {
                            selectedGradeBucket = bucket
                            applyGradedSelection()
                        }
                    }
                }
            }
            if gradePerfSeries.count >= 2 {
                gradePerfScaleToggle
            }
        }
    }

    private var gradePerfScaleToggle: some View {
        HStack(spacing: 2) {
            ForEach([MultiSeriesChartModel.Scale.indexed, MultiSeriesChartModel.Scale.absolute], id: \.self) { mode in
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { gradePerfScale = mode }
                } label: {
                    Text(mode == .indexed ? "%" : "$")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(gradePerfScale == mode ? PA.Colors.background : PA.Colors.muted)
                        .frame(width: 30, height: 24)
                        .background(gradePerfScale == mode ? detailAccent : PA.Colors.surfaceSoft)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Fetches per-bucket history for the active grader in parallel and
    /// assembles the overlay series (high grade → low). Cleared when not in
    /// graded mode or fewer than two buckets have data.
    private func loadGradePerformance() async {
        guard case let .graded(grader, _) = selectedPriceMode else {
            await MainActor.run { gradePerfSeries = [] }
            return
        }
        let buckets = availableGradedOptions.compactMap { mode -> String? in
            if case let .graded(provider, bucket) = mode, provider == grader { return bucket }
            return nil
        }
        guard buckets.count >= 2 else {
            await MainActor.run { gradePerfSeries = [] }
            return
        }

        let slug = activeCard.id
        let printingId = selectedPrintingId
        let tf = selectedTimeframe

        var fetched: [String: [PricePoint]] = [:]
        await withTaskGroup(of: (String, [PricePoint]).self) { group in
            for bucket in buckets {
                group.addTask {
                    do {
                        let pts: [PricePoint]
                        if let pid = printingId {
                            pts = try await CardService.shared.fetchPrintingGradedPriceHistory(
                                slug: slug, printingId: pid, provider: grader, bucket: bucket, timeframe: tf
                            )
                        } else {
                            pts = try await CardService.shared.fetchGradedPriceHistory(
                                slug: slug, provider: grader, bucket: bucket, timeframe: tf
                            )
                        }
                        return (bucket, pts)
                    } catch {
                        return (bucket, [])
                    }
                }
            }
            for await (bucket, pts) in group where pts.count >= 2 {
                fetched[bucket] = pts
            }
        }

        let ordered: [GradePerfDatum] = Self.gradePerfOrder.compactMap { bucket in
            guard let pts = fetched[bucket] else { return nil }
            return GradePerfDatum(
                id: bucket,
                label: gradePerfLabel(bucket),
                color: gradePerfColor(bucket),
                points: pts
            )
        }

        await MainActor.run {
            // Drop the result if the user has since changed grader / timeframe /
            // printing / card (mirrors loadChart's staleness guard).
            guard activeCard.id == slug,
                  selectedTimeframe == tf,
                  selectedPrintingId == printingId,
                  case let .graded(currentGrader, _) = selectedPriceMode,
                  currentGrader == grader else { return }
            gradePerfSeries = ordered
        }
    }

    // MARK: - RAW Variant Overlay (all printings — every finish, edition, stamp)

    private struct VariantSeriesDatum: Identifiable {
        let id: String        // printingId
        let label: String
        let color: Color
        let points: [PricePoint]
    }

    // Stable, vivid colors assigned to printings by position (1st finish → [0],
    // 2nd → [1], …) so a printing keeps one color across the chart, legend, and
    // pills. 3rd = purple, 4th = red per design; all kept distinct so a 3–4
    // finish overlay stays legible.
    private static let variantPalette: [Color] = [
        PA.Colors.accent,                               // 1st — teal
        Color(red: 0.984, green: 0.749, blue: 0.141),   // 2nd — amber
        Color(red: 0.659, green: 0.545, blue: 0.980),   // 3rd — purple
        Color(red: 0.918, green: 0.263, blue: 0.275),   // 4th — red
        Color(red: 0.376, green: 0.647, blue: 0.980),   // 5th — blue
    ]

    /// Short legend label for a printing in the overlay. Prepends the finish
    /// (Holo / Reverse Holo / Regular…) when the overlay spans more than one
    /// finish, then edition (1st Ed) + stamp (Shadowless, Poké Ball…).
    /// "Unlimited" when it carries none of those.
    private func variantLabel(_ p: CardPrintingOption, includeFinish: Bool) -> String {
        var parts: [String] = []
        if includeFinish { parts.append(p.finishLabel) }
        if p.edition == "FIRST_EDITION" { parts.append("1st Ed") }
        if let stamp = p.stamp, !stamp.isEmpty { parts.append(CardPrintingOption.stampLabel(stamp)) }
        return parts.isEmpty ? "Unlimited" : parts.joined(separator: " · ")
    }

    /// Every printing of this card — all finishes, editions, and stamps —
    /// overlaid on one graph (e.g. Holo Unlimited + Regular + Reverse Holo +
    /// 1st Ed). Capped to the palette size so the overlay stays readable;
    /// printings without enough chartable history are dropped downstream. The
    /// selected printing is always kept even when it sorts past the cap
    /// (fetchPrintings orders by finish), so changing finish never renders an
    /// overlay that omits the user's current pick.
    private var variantGroupPrintings: [CardPrintingOption] {
        let cap = Self.variantPalette.count
        let head = Array(availablePrintings.prefix(cap))
        // Common case (≤ cap, or the selection is already in the first `cap`):
        // natural order → stable colors, selection included.
        if availablePrintings.count <= cap || head.contains(where: { $0.id == selectedPrintingId }) {
            return head
        }
        // More printings than colors and the selection sorts past the cap:
        // swap it in so the user's pick is always on the chart.
        guard let active = availablePrintings.first(where: { $0.id == selectedPrintingId }) else { return head }
        return [active] + head.dropLast()
    }

    /// True once at least two variants of the active finish have chartable
    /// history (single-printing cards never trip this).
    private var hasVariantOverlay: Bool { variantSeries.count >= 2 }

    @ViewBuilder
    private var chartContent: some View {
        if selectedPriceMode.isGraded, gradePerfSeries.count >= 2 {
            // Graded mode ALWAYS charts the blended grade ladder — never
            // a single isolated line (single-bucket cards fall through to
            // the plain chart below, there's nothing to blend). Observed
            // dollars by default; the %/$ toggle flips to indexed
            // momentum. Loot-rarity colors rank the lines; the selected
            // grade pill drives only the headline price and metrics.
            MultiLineChartView(
                series: gradePerfSeries.map { MultiLineSeriesInput(id: $0.id, label: $0.label, color: $0.color, points: $0.points) },
                scale: gradePerfScale,
                showChangeDetails: true,
                height: 140,
                showsBounds: true
            )
        } else if !selectedPriceMode.isGraded, hasVariantOverlay {
            if let sel = selectedPrintingId, let one = variantSeries.first(where: { $0.id == sel }) {
                // A specific finish is selected → isolate its line.
                InteractiveChartView(data: one.points.map(\.price), timestamps: one.points.map(\.ts), direction: variantDirection(one.points), lineWidth: 2, height: 140, showsBounds: true)
            } else {
                // "All" → every finish overlaid on a normalized (indexed) scale, so a
                // low-dollar Reverse Holo stays visible beside a high-dollar Holo.
                MultiLineChartView(
                    series: variantSeries.map { MultiLineSeriesInput(id: $0.id, label: $0.label, color: $0.color, points: $0.points) },
                    scale: .indexed,
                    showChangeDetails: true,
                    height: 140,
                    showsBounds: true
                )
            }
        } else {
            InteractiveChartView(data: activeChartPrices, timestamps: activeChartTimestamps, direction: chartDirection, lineWidth: 2, height: 140, showsBounds: true)
        }
    }

    private var variantSelectPills: some View {
        // Finish prefix only when finishes actually differ, so a single-finish
        // card's edition pills read "1st Ed" / "Unlimited" rather than
        // "Holo · 1st Ed" / "Holo · Unlimited".
        let mixedFinish = Set(availablePrintings.map(\.finishLabel)).count > 1
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                variantPill("All", isActive: selectedPrintingId == nil) { selectedPrintingId = nil }
                // Every selectable printing — not just the chartable ones. A charted
                // finish mirrors its overlay line's color (lookup → always matches +
                // stays distinct); a finish with no line falls back to its palette
                // slot so it still shows a color instead of a blank dot.
                ForEach(Array(availablePrintings.enumerated()), id: \.element.id) { idx, p in
                    variantPill(
                        variantLabel(p, includeFinish: mixedFinish),
                        isActive: selectedPrintingId == p.id,
                        dot: variantSeries.first(where: { $0.id == p.id })?.color
                              ?? Self.variantPalette[idx % Self.variantPalette.count]
                    ) { selectedPrintingId = p.id }
                }
            }
        }
    }

    private func variantPill(_ title: String, isActive: Bool, dot: Color? = nil, _ action: @escaping () -> Void) -> some View {
        Button {
            PAHaptics.selection()
            withAnimation(.easeInOut(duration: 0.15)) { action() }
        } label: {
            HStack(spacing: 5) {
                if let dot {
                    Circle().fill(dot).frame(width: 6, height: 6)
                }
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isActive ? PA.Colors.background : PA.Colors.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isActive ? detailAccent : PA.Colors.surfaceSoft)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func variantDirection(_ pts: [PricePoint]) -> ChangeDirection {
        guard pts.count >= 2, let first = pts.first?.price, let last = pts.last?.price else { return .flat }
        return ChangeDirection.from(last - first)
    }

    /// Fetches each comparable variant's raw history in parallel. Cleared when
    /// not in RAW mode or the active finish has fewer than two variants.
    private func loadVariantOverlay() async {
        guard !selectedPriceMode.isGraded else {
            await MainActor.run { variantSeries = [] }
            return
        }
        let group = variantGroupPrintings
        guard group.count >= 2 else {
            await MainActor.run { variantSeries = [] }
            return
        }
        let slug = activeCard.id
        let tf = selectedTimeframe

        var fetched: [String: [PricePoint]] = [:]
        await withTaskGroup(of: (String, [PricePoint]).self) { taskGroup in
            for p in group {
                let pid = p.id
                taskGroup.addTask {
                    let pts = (try? await CardService.shared.fetchPrintingPriceHistory(slug: slug, printingId: pid, timeframe: tf)) ?? []
                    return (pid, pts)
                }
            }
            for await (pid, pts) in taskGroup where pts.count >= 2 {
                fetched[pid] = pts
            }
        }

        // Show the finish in each legend label only when the overlay actually
        // spans more than one finish (otherwise "Holo" on every line is noise).
        let mixedFinish = Set(group.map(\.finish)).count > 1
        // Color drawn lines by their position in the (capped) overlay set so the
        // ≤5 lines on screen are always mutually distinct. Pills mirror a line's
        // color via a lookup (below), so a line and its pill never drift apart.
        let ordered: [VariantSeriesDatum] = group.enumerated().compactMap { idx, p in
            guard let pts = fetched[p.id] else { return nil }
            return VariantSeriesDatum(
                id: p.id,
                label: variantLabel(p, includeFinish: mixedFinish),
                color: Self.variantPalette[idx % Self.variantPalette.count],
                points: pts
            )
        }

        await MainActor.run {
            guard activeCard.id == slug, selectedTimeframe == tf, !selectedPriceMode.isGraded else { return }
            variantSeries = ordered
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

    /// JP cards: the per-source breakdown (Yahoo! Auctions JP + Snkrdunk),
    /// moved out of the hero into its own bottom metadata panel — same
    /// glass-surface treatment as the details tiles. The hero shows the single
    /// blended read; this shows the unblended sources so the user can judge
    /// them. Reuses sourceAttributionLine, so no per-source detail is lost.
    /// Renders nothing for non-JP cards or when no JP source has data.
    @ViewBuilder
    private var jpSourcesPanel: some View {
        if isJapaneseCard {
            let yj = cardMetrics?.yahooJpPrice ?? 0
            let snk = cardMetrics?.snkrdunkPrice ?? 0
            if yj > 0 || snk > 0 {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Native Sources")
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                        .tracking(0.4)
                        .textCase(.uppercase)
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
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .glassSurface()
                .padding(.top, 8)
            }
        }
    }

    /// Derives a user-facing Confidence label from the numeric score.
    /// Prefers the FETCHED metrics row over the navigation stub: search /
    /// scan / language-toggle entry builds MarketCard with
    /// confidenceScore nil, which left this tile stuck on "—" even after
    /// public_card_metrics landed. Canonical row first — per-printing rows
    /// are usually PUBLIC_ONLY/low-confidence and shouldn't downgrade the
    /// card-level tile when a finish pill is tapped (same precedence as
    /// heroChange's changeSource). Thin-tier JP rows (server PR #248)
    /// carry market_confidence_score 30 and now honestly read "Low".
    /// Falls back to a muted em-dash when nothing has loaded yet.
    private var confidenceDescriptor: (label: String, tone: DetailTone) {
        let fetchedScore = canonicalMetrics?.marketConfidenceScore
            ?? cardMetrics?.marketConfidenceScore
        guard let score = fetchedScore ?? activeCard.confidenceScore else {
            return ("—", .muted)
        }
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
        let listings = metrics.activeListings7D ?? 0
        let snapshots = metrics.snapshotCount30D ?? 0
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
                .font(.system(size: 21, weight: .bold))
                .foregroundStyle(PA.Colors.background)
                // 48pt matches the iOS 26 minimized tab pill (measured
                // 47.7pt capsule) so the two corner controls read as
                // equal weights (owner request 2026-06-12).
                .frame(width: 48, height: 48)
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

    private var aiBriefSection: some View {
        // Group exists so the paywall sheet can attach HERE — outside
        // both the dark pins (panel + locked overlay), so PaywallView
        // keeps the user's appearance. It previously hung off
        // aiBriefCard, which sits INSIDE the locked overlay's pin
        // (codex P2 ×2 on PR #253).
        Group {
            aiBriefSectionBody
        }
        .sheet(isPresented: $showMarketSummaryPaywall) {
            PaywallView(
                context: .generic,
                surface: "card_detail_market_summary_teaser",
                personalization: .init(cardName: activeCard.name, cardChangePct: heroChange.pct)
            )
        }
    }

    @ViewBuilder
    private var aiBriefSectionBody: some View {
        if let profile = cardProfile {
            if premiumGate.canRevealAnalysis(slug: activeCard.id) {
                aiBriefCard {
                    aiBriefHeader(chip: profile.chip)
                    aiBriefUnlockedBody(profile)
                    // Visible metering: free users see how much of the free
                    // budget they've burned, with the same accent capsule
                    // they'll meet on the locked cards — so the upgrade is
                    // contextual rather than hitting a silent wall on the
                    // next card. Shown on every unlocked brief for free
                    // users, including re-views after the budget is spent
                    // ("3 of 3" — the most persuasive moment).
                    if !premiumGate.isPro {
                        freeAnalysisMeter
                    }
                }
                // market_brief_viewed: the user saw the REAL, readable brief
                // (free pre-budget or Pro). .task(id:) re-runs on an in-place
                // slug swap; the Set keeps it to once per card.
                .task(id: activeCard.id) {
                    let slug = activeCard.id
                    guard !loggedBriefSlugs.contains(slug) else { return }
                    loggedBriefSlugs.insert(slug)
                    AnalyticsService.shared.capture(.marketBriefViewed, properties: [
                        "slug": slug,
                        "is_pro": premiumGate.isPro,
                    ])
                }
            } else {
                // Free budget spent: the WHOLE card — header, chip, and the
                // REAL summary — glosses out under the frost, clipped to the
                // card's own corners, with a single unlock CTA.
                lockedAiBriefCard(profile)
            }
        } else if !premiumGate.isPro {
            // Profile not loaded yet (or none exists) — light teaser so the
            // section still renders with shape.
            lockedAiBriefCard(nil)
        }
    }

    /// Full-card gloss for the locked summary: the overlay wraps the
    /// entire card (not an inner region), so the frost runs edge-to-edge
    /// and hugs the container's continuous corners — no inner box.
    private func lockedAiBriefCard(_ profile: CardProfileResult?) -> some View {
        LockedPreviewOverlay(
            ctaText: "Unlock Pro Insights",
            cornerRadius: PA.Layout.panelRadius,
            onTap: { showMarketSummaryPaywall = true }
        ) {
            aiBriefCard {
                aiBriefHeader(chip: "Pro")
                aiBriefLockedPreview(profile)
            }
        }
        // Pin the OVERLAY too — its frost material and CTA chrome sit
        // outside aiBriefCard's pin and were rendering their light
        // variants over the dark panel (codex P2 on PR #253). The
        // paywall sheet attaches at aiBriefSection, outside this pin.
        .environment(\.colorScheme, .dark)
    }

    /// Free-budget banner under the unlocked brief: "You've used X of 3
    /// intelligence briefs." with a compact Upgrade to Pro capsule that
    /// mirrors the locked cards' CTA (same gradient + arrow, smaller) so
    /// the metered state and the locked state read as one system.
    private var freeAnalysisMeter: some View {
        let used = min(premiumGate.freeAnalysisSeenCount, PremiumGate.freeAnalysisLimit)
        return HStack(spacing: 10) {
            Text("You've used \(used) of \(PremiumGate.freeAnalysisLimit) intelligence briefs.")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(PA.Colors.textSecondary)

            Spacer(minLength: 0)

            Button {
                PAHaptics.tap()
                showMarketSummaryPaywall = true
            } label: {
                HStack(spacing: 4) {
                    Text("Upgrade to Pro")
                        .font(.system(size: 11, weight: .bold))
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    LinearGradient(
                        colors: [PA.Colors.accent, PA.Colors.accent.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 2)
    }

    private func aiBriefCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Match the front-page AI brief container (AIBriefCard) so the two
        // read as the same component.
        .liquidGlassSurface(accent: detailAccent)
        // Opaque dark base under the translucent glass — the dark look
        // depends on dark content behind the material, which a light
        // page doesn't provide (fill resolves dark via the pin below).
        // Ambient-dark keeps .clear so the detail page's accent glow
        // still bleeds through the material as designed. `colorScheme`
        // here reads the AMBIENT scheme — the property resolves outside
        // the pin.
        .background(
            RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
                .fill(colorScheme == .light ? PA.Colors.background : Color.clear)
        )
        // Pin the summary panel to its dark-theme rendering in BOTH
        // appearances, matching AIBriefCard (owner request 2026-06-12:
        // "make the AI briefs the same colors as the dark theme
        // version"). The paywall sheet attaches at aiBriefSection,
        // outside this pin.
        .environment(\.colorScheme, .dark)
    }

    private func aiBriefHeader(chip: String?) -> some View {
        // "POPALPHA SUMMARY" eyebrow — renamed from "AI BRIEF" (2026-06-10,
        // de-AI of user-facing value props) while keeping the same eyebrow
        // styling as the front-page brief so the two still read as kin.
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(detailAccent)
                    .accessibilityHidden(true)
                Text("POPALPHA SUMMARY")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(detailAccent)
                    .accessibilityAddTraits(.isHeader)
            }
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
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.text)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)

        if let interpretation = summaryInterpretation(from: profile) {
            Text(interpretation)
                .font(.system(size: 14, weight: .regular))
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

    /// The body that renders UNDER the full-card gloss (see
    /// lockedAiBriefCard). The real summary text, not a placeholder — the
    /// overlay dissolves it into the card's color aura, so the tease is
    /// the card's genuine shape and hue without a legible word.
    private func aiBriefLockedPreview(_ profile: CardProfileResult?) -> some View {
            VStack(alignment: .leading, spacing: 8) {
                if let profile {
                    // The REAL AI summary, blurred behind the invisible-ink
                    // overlay — a legible-shaped tease of the actual read for
                    // this card, not a generic placeholder. Same 14pt type as
                    // the unlocked body / front-page brief.
                    Text(summaryHeadline(from: profile))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                    if let interpretation = summaryInterpretation(from: profile) {
                        Text(interpretation)
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(PA.Colors.textSecondary)
                            .lineSpacing(3)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    // No profile loaded yet — keep a light teaser so the
                    // section still has shape while the read loads.
                    Text("Momentum, liquidity, and confidence read")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.text.opacity(0.85))
                    Text("Interpretation tuned to the card's current market signals and recent observations.")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineSpacing(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
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
                infoRow(label: "7D Median", value: formatMedian7d(cardMetrics?.median7D))
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
    // MARK: - Live eBay listings (section 12)

    /// Decodable mirror of /api/ebay/browse's mapBrowseItem payload.
    /// The route already relevance-filters and sorts by total ask.
    struct EbayListing: Decodable, Identifiable {
        struct Money: Decodable {
            let value: String
            let currency: String
        }
        let externalId: String
        let title: String
        let price: Money?
        let shipping: Money?
        let itemWebUrl: String
        let image: String?
        let condition: String?

        var id: String { externalId.isEmpty ? itemWebUrl : externalId }

        /// Price + shipping, the number a buyer actually pays.
        var totalAsk: Double? {
            guard let p = price.flatMap({ Double($0.value) }) else { return nil }
            return p + (shipping.flatMap { Double($0.value) } ?? 0)
        }
    }

    private struct EbayBrowseEnvelope: Decodable {
        let ok: Bool
        let total: Int?
        let items: [EbayListing]?
    }

    private var ebayListingsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("Live eBay Listings")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(PA.Colors.text)
                if ebayLoadState == .loaded, ebayTotalAsks > 0 {
                    Text("\(ebayTotalAsks) asks")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                Spacer()
            }

            switch ebayLoadState {
            case .idle, .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking live asks…")
                        .font(.system(size: 13))
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 10)
            case .failed:
                Button {
                    Task { await loadEbayListings(force: true) }
                } label: {
                    Label("Couldn't load listings — tap to retry", systemImage: "arrow.clockwise")
                        .font(.system(size: 13))
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 10)
            case .loaded:
                if ebayListings.isEmpty {
                    Text("No live listings matched this card right now.")
                        .font(.system(size: 13))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 10)
                } else {
                    // Horizontal photo-first carousel (owner spec
                    // 2026-06-12, replacing the old 5-row text list):
                    // the seller's photo is the point — it shows what's
                    // actually for sale. Lazy so off-screen listing
                    // images don't fetch until scrolled into view.
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: 10) {
                            ForEach(ebayListings.prefix(12)) { listing in
                                ebayListingCard(listing)
                            }
                        }
                    }
                    Text("Lowest total ask first · prices include shipping · PopAlpha may earn a commission")
                        .font(.system(size: 10))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
        }
        .padding(16)
        .glassSurface()
        // task(id:) so a JP/EN language toggle (which swaps activeCard
        // in place) refetches for the new card instead of showing the
        // previous card's asks (codex P2).
        .task(id: activeCard.id) { await loadEbayListings() }
    }

    /// One carousel tile: the seller's photo on top (the part that tells
    /// you what's actually being sold), then total ask, title, condition.
    /// Fixed tile width + reserved 2-line title keep the row height
    /// uniform across tiles.
    private func ebayListingCard(_ listing: EbayListing) -> some View {
        Button {
            guard let url = URL(string: listing.itemWebUrl) else { return }
            PAHaptics.tap()
            openURL(url)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                LazyImage(url: listing.image.flatMap(URL.init(string:))) { state in
                    if let image = state.image {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(PA.Colors.surfaceSoft)
                    }
                }
                .frame(width: 124, height: 165)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                if let total = listing.totalAsk {
                    Text(total, format: .currency(code: listing.price?.currency ?? "USD"))
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(PA.Colors.text)
                }

                Text(listing.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 3) {
                    if let condition = listing.condition, !condition.isEmpty {
                        Text(condition)
                    }
                    Image(systemName: "arrow.up.right")
                }
                .font(.system(size: 10))
                .foregroundStyle(PA.Colors.muted)
            }
            .frame(width: 124, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(listing.title), opens on eBay")
    }

    /// Fetches live listings once per card view. The query mirrors the
    /// web card page's primary eBay search ("name number setName") and
    /// lets the route's relevance filter + total-ask sort do the rest.
    private func loadEbayListings(force: Bool = false) async {
        let cardId = activeCard.id
        if !force, ebayLoadState != .idle, ebayLoadedCardId == cardId { return }
        ebayLoadedCardId = cardId
        ebayLoadState = .loading
        let name = activeCard.name.trimmingCharacters(in: .whitespacesAndNewlines)
        // MarketCard.cardNumber is the display form ("#199") — the
        // route's card-number relevance filter expects the bare number
        // and returns zero matches when the hash leaks through
        // (verified against prod 2026-06-11). Keep letters/slashes:
        // numbers like TG12/TG30 are real.
        var number = activeCard.cardNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        if number.hasPrefix("#") { number = String(number.dropFirst()) }
        let setName = activeCard.setName.trimmingCharacters(in: .whitespacesAndNewlines)
        let q = [name, number, setName].filter { !$0.isEmpty }.joined(separator: " ")
        guard !q.isEmpty else {
            ebayLoadState = .loaded
            ebayListings = []
            return
        }
        var query: [(String, String)] = [
            ("q", q),
            ("canonicalName", name),
            ("grade", "RAW"),
            ("limit", "20"),
        ]
        if !setName.isEmpty { query.append(("setName", setName)) }
        if !number.isEmpty { query.append(("cardNumber", number)) }
        Logger.api.debug("ebay fetch q='\(q, privacy: .public)'")
        do {
            let envelope: EbayBrowseEnvelope = try await APIClient.get(
                path: "/api/ebay/browse",
                query: query
            )
            guard envelope.ok else { throw URLError(.badServerResponse) }
            // Route order is item-price ascending; re-sort by TOTAL
            // buyer cost (price + shipping) so "lowest total ask first"
            // is true when shipping varies (codex P2).
            ebayListings = (envelope.items ?? [])
                .filter { $0.totalAsk != nil }
                .sorted { ($0.totalAsk ?? .infinity) < ($1.totalAsk ?? .infinity) }
            ebayTotalAsks = envelope.total ?? ebayListings.count
            ebayLoadState = .loaded
            Logger.api.debug("ebay loaded items=\(envelope.items?.count ?? -1, privacy: .public) kept=\(self.ebayListings.count, privacy: .public)")
        } catch {
            if Task.isCancelled { return }
            Logger.api.debug("ebay failed: \(String(describing: error), privacy: .public)")
            ebayLoadState = .failed
        }
    }

    // MARK: - Report a bug (section 13)

    enum BugReportCategory: String, CaseIterable, Identifiable {
        case wrongPrice = "wrong_price"
        case wrongMetadata = "wrong_metadata"
        case other = "other"

        var id: String { rawValue }
        var label: String {
            switch self {
            case .wrongPrice:    "Wrong price"
            case .wrongMetadata: "Wrong name, set, or image"
            case .other:         "Something else"
            }
        }
    }

    private var bugReportSection: some View {
        VStack(spacing: 6) {
            Button {
                PAHaptics.tap()
                showBugCategoryDialog = true
            } label: {
                Label(
                    bugReportSubmitted ? "Thanks — report sent" : "Report an issue with this card",
                    systemImage: bugReportSubmitted ? "checkmark.circle.fill" : "exclamationmark.bubble"
                )
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(bugReportSubmitted ? PA.Colors.positive : PA.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(bugReportSubmitted)
        }
        .confirmationDialog(
            "What's wrong on this page?",
            isPresented: $showBugCategoryDialog,
            titleVisibility: .visible
        ) {
            ForEach(BugReportCategory.allCases) { category in
                Button(category.label) {
                    pendingBugCategory = category
                    bugNoteText = ""
                    showBugNoteAlert = true
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert(
            pendingBugCategory?.label ?? "Report an issue",
            isPresented: $showBugNoteAlert
        ) {
            TextField("Add a detail (optional)", text: $bugNoteText)
            Button("Send") { submitBugReport() }
            Button("Cancel", role: .cancel) { pendingBugCategory = nil }
        } message: {
            Text("Goes straight to the team with this card attached.")
        }
    }

    /// Same v1 inbox pattern as Request-a-Feature: a typed PostHog event
    /// (`bug_reported`) carrying the card context, triaged by category
    /// as a PostHog insight. No backend table until volume demands one.
    private func submitBugReport() {
        guard let category = pendingBugCategory else { return }
        let note = bugNoteText.trimmingCharacters(in: .whitespacesAndNewlines)
        var properties: [String: Any] = [
            "category": category.rawValue,
            "slug": activeCard.id,
            "card_name": activeCard.name,
            "set_name": activeCard.setName,
            "card_number": activeCard.cardNumber,
            "source": "card_detail",
        ]
        if !note.isEmpty {
            properties["note"] = String(note.prefix(1000))
        }
        AnalyticsService.shared.capture(.bugReported, properties: properties)
        PAHaptics.tap()
        withAnimation(.easeInOut(duration: 0.2)) { bugReportSubmitted = true }
        pendingBugCategory = nil
    }

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

    /// Single attribution line in the bottom JP sources panel — shows the
    /// source name, optional JPY equivalent, and sample-count. Used twice on JP
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

    /// Per-(grader, bucket) market-summary stats for the selected graded variant.
    /// public_graded_variant_prices IS per-grader, so this keys by "GRADER::bucket"
    /// — tapping PSA vs CGC swaps to that grader's own row (e.g. PSA 10 $3,431 vs
    /// CGC 10 $761). Renders only when graded mode is selected AND we have a row
    /// for the active (grader, bucket).
    @ViewBuilder
    private var gradedMarketSummarySection: some View {
        if case .graded(let provider, let bucket) = selectedPriceMode,
           let metric = gradedCardMetricsByBucket["\(provider)::\(bucket)"] {
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
        // Lead with the 14-day median (the per-grader headline). Graded 7d windows
        // are often empty, so the emphasis falls back to 7D only when 14D is absent.
        if let market = metric.marketPrice {
            rows.append(.init(label: "14D Median", value: formatConditionPrice(market), emphasized: true))
        }
        if let median7d = metric.median7d {
            rows.append(.init(label: "7D Median", value: formatConditionPrice(median7d), emphasized: metric.marketPrice == nil))
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

                // (The old Row 3 grade picker wheel is gone — grade
                // selection lives on the chart's grade pills, which carry
                // the loot-rarity dot for each bucket.)
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
                // Low-dollar cards render the exact price (matches the
                // homepage + web) with a "Low-dollar card" caption below,
                // instead of hiding the number behind an "Abundant" label.
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

// MARK: - Minimized-tab-bar scroll mirror

/// Drives `CardDetailView.tabBarLikelyMinimized`, mirroring
/// `.tabBarMinimizeBehavior(.onScrollDown)` (ContentView). No-op before
/// iOS 26, where the legacy opaque bar never minimizes.
///
/// There is no public "is the bar minimized" state, so this mirrors the
/// behavior reverse-engineered via held-drag probes on the iPhone 17
/// Pro Max simulator (iOS 26.3, 2026-06-12):
///
///   • MINIMIZE on cumulative downward travel (~82–137pt observed,
///     fires mid-gesture even while the finger is still down; speed
///     doesn't matter).
///   • RE-EXPAND only at (essentially) the top, or when a presentation
///     appears. NO scroll gesture restores the bar mid-page — slow
///     up-drags of 82/150/225pt (held AND released) and a ~340pt fast
///     up-flick all left it minimized; every frame where it had
///     re-expanded turned out to be at-top or post-presentation.
///
/// A naive direction mirror moved the FAB a beat before the bar
/// (owner: "there's kind of a delay between the two"); matching the
/// real triggers means both animations start on the same gesture
/// moment. Known unobservable hole: tapping the minimized pill itself
/// expands the bar with no signal we can see — the FAB stays low until
/// the next top/presentation. If an iOS update retunes the system,
/// retune `minimizeAfterDown`.
private struct TabBarMinimizeMirror: ViewModifier {
    @Binding var minimized: Bool
    /// CardDetailView.ownedPresentationActive — the system re-expands
    /// the bar when a presentation appears, so this flipping true
    /// resets the mirror.
    var presentationActive: Bool

    /// Per-tick bookkeeping lives in a reference box so writes don't
    /// invalidate the view — onScrollGeometryChange fires every frame.
    private final class Tracker {
        /// Signed displacement since the last direction change, in
        /// points. Positive = scrolling down.
        var run: CGFloat = 0
    }

    @State private var tracker = Tracker()

    /// Mid-point of the observed 82–137pt system band.
    private static let minimizeAfterDown: CGFloat = 110

    private struct Probe: Equatable {
        var offset: CGFloat
        var maxOffset: CGFloat
    }

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .onScrollGeometryChange(for: Probe.self) { geometry in
                    Probe(
                        offset: geometry.contentOffset.y + geometry.contentInsets.top,
                        maxOffset: max(
                            0,
                            geometry.contentSize.height + geometry.contentInsets.top
                                + geometry.contentInsets.bottom - geometry.containerSize.height
                        )
                    )
                } action: { oldProbe, newProbe in
                    // Clamp into the scrollable range so top/bottom
                    // rubber-banding contributes no displacement — a
                    // top bounce must not over-count and a bottom
                    // bounce must not look like upward travel.
                    let oldY = min(max(oldProbe.offset, 0), newProbe.maxOffset)
                    let newY = min(max(newProbe.offset, 0), newProbe.maxOffset)
                    // ≤8pt is "essentially at the top" — the only scroll
                    // position where the system re-expands the bar.
                    if newY <= 8 {
                        tracker.run = 0
                        if minimized { minimized = false }
                        return
                    }
                    let delta = newY - oldY
                    guard delta != 0 else { return }
                    if (delta > 0) != (tracker.run > 0) { tracker.run = 0 }
                    tracker.run += delta
                    if tracker.run > Self.minimizeAfterDown, !minimized {
                        minimized = true
                    }
                }
                .onChange(of: presentationActive) { _, active in
                    if active {
                        tracker.run = 0
                        minimized = false
                    }
                }
        } else {
            content
        }
    }
}

// MARK: - Top bar chrome suppression

/// Hides BOTH iOS 26 layers that paint a band across the status/
/// toolbar area when content scrolls under it: the top scroll-edge
/// effect AND the navigation bar's own background appearance — see
/// the call site comment in `CardDetailView.body`. Strictly no-op
/// before iOS 26: the legacy bar keeps its background there because
/// the back/share buttons have no system Liquid Glass capsules on
/// older OSes (their custom circles were removed in favor of the
/// iOS 26 system chrome), so bare icons over content would lose
/// legibility.
private struct HideTopScrollEdgeEffect: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .scrollEdgeEffectHidden(true, for: .top)
                .toolbarBackground(.hidden, for: .navigationBar)
        } else {
            content
        }
    }
}
