import SwiftUI
import NukeUI

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

struct CardDetailView: View {
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

    init(card: MarketCard, scanImageHash: String? = nil, scanImage: UIImage? = nil) {
        self.card = card
        self.scanImageHash = scanImageHash
        self.scanImage = scanImage
    }

    @Environment(\.dismiss) private var dismiss
    @State private var showCorrectionSheet = false
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

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                heroSection
                if scanImageHash != nil {
                    correctionPrompt
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }
                detailContent
            }
            .background(alignment: .top) {
                // Accent glow — centered on card, bleeds into content below
                Ellipse()
                    .fill(PA.Colors.accent)
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
                    slug: card.id,
                    cardName: card.name,
                    setName: card.setName,
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
        .alert("Sign in to save \(card.name)?", isPresented: $showSignInPromptForAdd) {
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
                EvalSeedingView(
                    mode: .correction(imageHash: hash, predictedSlug: card.id),
                    scanImage: scanImage,
                    isPresented: $showCorrectionSheet
                )
            }
        }
        .task(id: "\(selectedTimeframe.rawValue)|\(selectedPriceMode)|\(selectedPrintingId ?? "")") {
            await loadChart()
        }
        .task {
            cardProfile = try? await CardService.shared.fetchCardProfile(slug: card.id)
            cardMetrics = try? await CardService.shared.fetchCardMetrics(slug: card.id)
            if AuthService.shared.isAuthenticated {
                friendActivity = try? await ActivityService.shared.fetchCardActivity(slug: card.id)
            }
            // Fire a card_view personalization event once per appearance.
            await PersonalizationService.shared.track(
                PersonalizedEvent(
                    type: .cardView,
                    canonicalSlug: card.id,
                    variantRef: selectedPrintingId.map { "\($0)::RAW" }
                )
            )
            // Load available finish variants. Ordering is handled downstream
            // by `toFinishGroups()` so the picker controls the visual order.
            if let printings = try? await CardService.shared.fetchPrintings(slug: card.id) {
                let groups = printings.toFinishGroups()
                let initialId = groups.first?.defaultPrintingId ?? printings.first?.id
                await MainActor.run {
                    availablePrintings = printings
                    if selectedPrintingId == nil { selectedPrintingId = initialId }
                }
            }
            // Load condition-based prices
            if let prices = try? await CardService.shared.fetchConditionPrices(
                slug: card.id,
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
            if let rows = try? await CardService.shared.fetchGradedCardMetrics(slug: card.id) {
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
            if let rows = try? await CardService.shared.fetchGradedVariantMetrics(slug: card.id) {
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
            AddHoldingSheet(preselectedCard: card.asSearchResult)
        }
        .onChange(of: selectedPrintingId) {
            Task {
                if let prices = try? await CardService.shared.fetchConditionPrices(
                    slug: card.id,
                    printingId: selectedPrintingId
                ) {
                    await MainActor.run { conditionPrices = prices }
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
                    Button {} label: {
                        Image(systemName: "bell")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial.opacity(0.5))
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("Notifications")

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
                    if let shareURL = URL(string: "https://popalpha.ai/c/\(card.id)") {
                        ShareLink(
                            item: shareURL,
                            subject: Text(card.name.isEmpty ? "PopAlpha card" : card.name)
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
                    .foregroundStyle(PA.Colors.accent)
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
                    .fill(PA.Colors.accent.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(PA.Colors.accent.opacity(0.25), lineWidth: 1)
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
                // Freefloating card image
                if let url = card.imageURL {
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
                    Text(card.cardNumber)
                        .font(.system(size: 14, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.3))
                }
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
            if cardProfile != nil {
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
                canonicalSlug: card.id,
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
                        SetDetailView(setName: card.setName)
                    } label: {
                        HStack(spacing: 4) {
                            Text(card.setName)
                                .font(PA.Typography.cardSubtitle)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .foregroundStyle(PA.Colors.accent)
                    }
                    .buttonStyle(.plain)

                    Text(card.name)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                }

                Spacer()

                // Rarity badge
                Text(card.rarity.label.uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(card.rarity == .secretRare ? PA.Colors.gold : PA.Colors.accent)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        (card.rarity == .secretRare ? PA.Colors.gold : PA.Colors.accent).opacity(0.12)
                    )
                    .clipShape(Capsule())
            }

            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(currentHeroPrice)
                    .font(PA.Typography.heroPrice)
                    .foregroundStyle(PA.Colors.text)

                if !selectedPriceMode.isGraded {
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
        }
    }

    // MARK: - Chart (live data per timeframe)

    private var activeChartPrices: [Double] {
        chartPrices.isEmpty ? card.sparkline : chartPrices
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
            pct = card.changePct; window = card.changeWindow
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
                        .tint(PA.Colors.accent)
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
                                .foregroundStyle(PA.Colors.accent)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 6)
                                .overlay(
                                    Capsule().stroke(PA.Colors.accent.opacity(0.5), lineWidth: 1)
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
                        .fill(PA.Colors.accent.opacity(0.7))
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
        do {
            let points: [PricePoint]
            switch selectedPriceMode {
            case .nearMint:
                // Only use printing-specific history when the user can
                // actually choose a finish. For single-printing cards, the
                // printing_id filter matches multiple provider_variant cohorts
                // (e.g. ':normal' + ':reverseholofoil' under one printing) —
                // the canonical view resolves that to a single dominant
                // cohort via preferred_canonical_raw_variant_ref. See
                // supabase/migrations/20260422200000_canonical_pin_provider_variant.sql.
                if let printingId = selectedPrintingId, availablePrintings.count > 1 {
                    points = try await CardService.shared.fetchPrintingPriceHistory(
                        slug: card.id,
                        printingId: printingId,
                        timeframe: selectedTimeframe
                    )
                } else {
                    points = try await CardService.shared.fetchPriceHistory(
                        slug: card.id,
                        timeframe: selectedTimeframe
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
                if let printingId = selectedPrintingId {
                    points = try await CardService.shared.fetchPrintingGradedPriceHistory(
                        slug: card.id,
                        printingId: printingId,
                        provider: provider,
                        bucket: bucket,
                        timeframe: selectedTimeframe
                    )
                } else {
                    points = try await CardService.shared.fetchGradedPriceHistory(
                        slug: card.id,
                        provider: provider,
                        bucket: bucket,
                        timeframe: selectedTimeframe
                    )
                }
            }
            await MainActor.run {
                chartPrices = points.map(\.price)
                chartTimestamps = points.map(\.ts)
                chartLoading = false
                if selectedPriceMode.isGraded, let latest = points.last {
                    gradedHeroPrice = latest.price
                    printingHeroPrice = nil
                } else if let latest = points.last {
                    printingHeroPrice = latest.price
                } else {
                    printingHeroPrice = nil
                }
            }
        } catch {
            await MainActor.run {
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

        let setName = card.setName.trimmingCharacters(in: .whitespacesAndNewlines)
        tiles.append(MetaTile(
            title: "Set",
            value: setName.isEmpty ? "—" : setName,
            tone: setName.isEmpty ? .muted : .neutral
        ))

        let rawNumber = card.cardNumber.trimmingCharacters(in: .whitespaces)
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
        guard let score = card.confidenceScore else { return ("—", .muted) }
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
                .background(PA.Colors.accent)
                .clipShape(Circle())
                .shadow(color: PA.Colors.accent.opacity(0.4), radius: 12, x: 0, y: 4)
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
                canonicalSlug: card.id,
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
                autoAddError = "Couldn't save \(card.name) — try again from the + button."
            }
        }
    }

    /// Banner overlay shown briefly after a deferred-add auto-save lands.
    private var addedToPortfolioBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PA.Colors.positive)
            Text("Added \(card.name) to your portfolio")
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
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                    Text("Where this card stands today")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(PA.Colors.accent)
                        .kerning(-0.2)
                    Spacer(minLength: 0)
                    if let chip = profile.chip?.trimmingCharacters(in: .whitespacesAndNewlines), !chip.isEmpty {
                        Text(chip)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(PA.Colors.accent.opacity(0.28))
                            .clipShape(Capsule())
                            .overlay(
                                Capsule()
                                    .stroke(PA.Colors.accent.opacity(0.45), lineWidth: 1)
                            )
                    }
                }

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
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PA.Colors.accent.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .leading) {
                // Inset rounded rail — tucks inside the card's rounded
                // corners instead of trying to trace them.
                Capsule()
                    .fill(PA.Colors.accent)
                    .frame(width: 3)
                    .padding(.vertical, 10)
                    .padding(.leading, 2)
            }
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(PA.Colors.accent.opacity(0.35), lineWidth: 1)
            )
            .shadow(color: PA.Colors.accent.opacity(0.22), radius: 14, x: 0, y: 0)
            .shadow(color: .black.opacity(0.24), radius: 30, x: 0, y: 18)
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
        let count = chartPrices.isEmpty ? card.sparkline.count : chartPrices.count
        return count > 0 && count < 8
    }

    // MARK: - Market Info

    private var marketInfoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Market Intelligence")
                .font(PA.Typography.sectionTitle)
                .foregroundStyle(PA.Colors.text)

            VStack(spacing: 8) {
                infoRow(label: "Price Source", value: "Scrydex (primary)")
                infoRow(label: "Last Updated", value: "2 min ago")
                infoRow(label: "7D Median", value: formatMedian7d(cardMetrics?.median7d))
                infoRow(label: "Volatility", value: "Low")
            }
            .padding(16)
            .glassSurface()
        }
    }

    // MARK: - Friend Activity

    private func friendActivitySection(_ activity: ActivityService.CardActivityResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.accent)

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
                            .foregroundStyle(row.condition == "nm" ? PA.Colors.accent : PA.Colors.text)
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
                                    .foregroundStyle(row.emphasized ? PA.Colors.accent : PA.Colors.text)
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
                            .background(isActive ? PA.Colors.accent : PA.Colors.surfaceSoft)
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
                                    Capsule().stroke(isActive ? PA.Colors.accent.opacity(0.4) : PA.Colors.muted.opacity(0.15), lineWidth: 1)
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
                                .background(selectedGradingAgency == agency ? PA.Colors.accent : PA.Colors.surfaceSoft)
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
                .background(selected ? PA.Colors.accent : PA.Colors.surfaceSoft)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Grade-Aware Hero Price

    private var currentHeroPrice: String {
        switch selectedPriceMode {
        case .nearMint:
            // When a non-default printing is selected, show its latest price
            if let price = printingHeroPrice, price > 0 {
                if price >= 1000 { return String(format: "$%.0f", price) }
                return String(format: "$%.2f", price)
            }
            return card.formattedPrice
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
