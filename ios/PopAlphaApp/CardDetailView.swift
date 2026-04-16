import SwiftUI

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
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTimeframe: ChartTimeframe = .week
    @State private var chartPrices: [Double] = []
    @State private var chartTimestamps: [String] = []
    @State private var chartLoading = false
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

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                heroSection
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
            // Load available finish variants
            if let printings = try? await CardService.shared.fetchPrintings(slug: card.id) {
                let finishOrder = ["NON_HOLO", "HOLO", "REVERSE_HOLO", "ALT_HOLO", "UNKNOWN"]
                let sorted = printings.sorted {
                    (finishOrder.firstIndex(of: $0.finish) ?? 99) < (finishOrder.firstIndex(of: $1.finish) ?? 99)
                }
                await MainActor.run {
                    availablePrintings = sorted
                    if selectedPrintingId == nil { selectedPrintingId = sorted.first?.id }
                }
            }
            // Load condition-based prices
            if let prices = try? await CardService.shared.fetchConditionPrices(
                slug: card.id,
                printingId: selectedPrintingId
            ) {
                await MainActor.run { conditionPrices = prices }
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

                    Button {
                        PAHaptics.tap()
                        showAddHolding = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                                .font(.system(size: 12, weight: .bold))
                            Text("Add to Portfolio")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(PA.Colors.background)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(PA.Colors.accent)
                        .clipShape(Capsule())
                    }
                }
            }
        }
    }

    // MARK: - Hero (matches web canonical-card-floating-hero)

    private var heroSection: some View {
        GeometryReader { geo in
            let scrollY = geo.frame(in: .named("scroll")).minY
            let progress = max(0, min(-scrollY / 350, 1))

            ZStack {
                Color.clear // fill GeometryReader
                // Freefloating card image
                if let url = card.imageURL {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 420)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                                        .stroke(.white.opacity(0.1), lineWidth: 0.5)
                                )
                        case .failure:
                            heroPlaceholder
                        case .empty:
                            heroPlaceholder
                                .overlay(ProgressView().tint(PA.Colors.muted))
                        @unknown default:
                            heroPlaceholder
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
            .fill(Color.white.opacity(0.03))
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
            // Title + Price section
            pricingSection

            // Finish variant pill selector
            if availablePrintings.count > 1 {
                finishPillSection
            }

            // Grade mode pill selector
            gradePillSection

            // Condition price breakdown (NM / LP / MP / HP)
            if !conditionPrices.isEmpty && !selectedPriceMode.isGraded {
                conditionPriceSection
            }

            // Chart section
            chartSection

            // AI Brief
            if cardProfile != nil {
                aiBriefSection
            }

            // Personalized insight (sits adjacent to AI Brief; renders its own
            // fallback copy when there is not yet enough signal).
            PersonalizedInsightCardView(
                canonicalSlug: card.id,
                variantRef: selectedPrintingId.map { "\($0)::RAW" }
            )

            // Details grid
            detailsGrid

            // Action buttons
            actionButtons

            // Friend activity (only when authenticated)
            if let activity = friendActivity, activity.ownerCount > 0 || !activity.recent.isEmpty {
                friendActivitySection(activity)
            }

            // Market info — slight top padding establishes the next
            // section break after the primary action row.
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
                        Image(systemName: card.isPositive ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 12, weight: .bold))
                        Text(card.changeText)
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(card.isPositive ? PA.Colors.positive : PA.Colors.negative)

                    Text(card.changeWindow)
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

    private var chartIsPositive: Bool {
        guard activeChartPrices.count >= 2, let first = activeChartPrices.first, let last = activeChartPrices.last else {
            return card.isPositive
        }
        return last >= first
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
                    isPositive: chartIsPositive,
                    lineWidth: 2,
                    height: 140
                )
                .opacity(chartLoading ? 0.3 : 1)
                .animation(.easeOut(duration: 0.2), value: chartLoading)

                if chartLoading {
                    ProgressView()
                        .tint(PA.Colors.accent)
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
        do {
            let points: [PricePoint]
            switch selectedPriceMode {
            case .nearMint:
                if let printingId = selectedPrintingId {
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
                let resolvedBucket = gradeBucketToVariantRefBucket(bucket)
                if let printingId = selectedPrintingId {
                    points = try await CardService.shared.fetchPrintingGradedPriceHistory(
                        slug: card.id,
                        printingId: printingId,
                        provider: provider,
                        bucket: resolvedBucket,
                        timeframe: selectedTimeframe
                    )
                } else {
                    let variantSuffix = "::\(provider)::\(resolvedBucket)"
                    points = try await CardService.shared.fetchGradedPriceHistory(
                        slug: card.id,
                        variantRef: variantSuffix,
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

    private var actionButtons: some View {
        HStack(spacing: 10) {
            WatchlistButton(
                slug: card.id,
                cardName: card.name,
                setName: card.setName
            )

            Button {
                PAHaptics.tap()
                showAddHolding = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .bold))
                    Text("Add to Collection")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(PA.Colors.background)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(PA.Colors.accent)
                .clipShape(Capsule())
                .shadow(color: PA.Colors.accent.opacity(0.25), radius: 14, x: 0, y: 6)
            }
            .buttonStyle(.plain)
        }
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

    // MARK: - Finish Variant Selector

    private var finishPillSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Finish")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
                .textCase(.uppercase)

            HStack(spacing: 6) {
                ForEach(availablePrintings) { printing in
                    Button {
                        PAHaptics.selection()
                        selectedPrintingId = printing.id
                    } label: {
                        Text(printing.finishLabel)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(selectedPrintingId == printing.id ? PA.Colors.background : PA.Colors.text)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(selectedPrintingId == printing.id ? PA.Colors.accent : PA.Colors.surfaceSoft)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
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

    private func gradeBucketToVariantRefBucket(_ bucket: String) -> String {
        switch bucket {
        case "LE_7": return "7_OR_LESS"
        case "G8": return "8"
        case "G9": return "9"
        case "G9_5": return "9_5"
        case "G10": return "10"
        case "G10_PERFECT": return "10_PERFECT"
        default: return bucket
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

// MARK: - Previews

#Preview("Card Detail") {
    NavigationStack {
        CardDetailView(card: MockMarket.trendingCards[0])
    }
    .preferredColorScheme(.dark)
}

#Preview("High Value Card") {
    NavigationStack {
        CardDetailView(card: MockMarket.trendingCards[3])
    }
    .preferredColorScheme(.dark)
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
