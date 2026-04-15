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
        }
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
        ZStack(alignment: .bottom) {
            PA.Colors.background

            // Freefloating card art — no frame, just the card
            if let url = card.imageURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxHeight: 420)
                            .shadow(color: .black.opacity(0.6), radius: 32, x: 0, y: 16)
                    case .failure:
                        heroPlaceholder
                    case .empty:
                        heroPlaceholder
                            .overlay(ProgressView().tint(PA.Colors.muted))
                    @unknown default:
                        heroPlaceholder
                    }
                }
                .padding(.horizontal, 40)
                .padding(.top, 8)
            } else {
                heroPlaceholder
                    .padding(.horizontal, 40)
                    .padding(.top, 8)
            }

            // Bottom fade into content
            PA.Gradients.heroOverlay
                .frame(height: 100)
        }
        .frame(minHeight: 380)
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

            // Details grid
            detailsGrid

            // Action buttons
            actionButtons

            // Friend activity (only when authenticated)
            if let activity = friendActivity, activity.ownerCount > 0 || !activity.recent.isEmpty {
                friendActivitySection(activity)
            }

            // Market info
            marketInfoSection
        }
        .padding(PA.Layout.sectionPadding)
    }

    private var pricingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.setName)
                        .font(PA.Typography.cardSubtitle)
                        .foregroundStyle(PA.Colors.accent)

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
                Text("\(chartPrices.count) data points")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
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

    private var detailsGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible()), GridItem(.flexible())],
            spacing: 12
        ) {
            detailTile(title: "Set", value: card.setName)
            detailTile(title: "Number", value: card.cardNumber)
            detailTile(title: "Confidence", value: "High", tone: .accent)
            detailTile(title: "Liquidity", value: "Strong", tone: .positive)
        }
    }

    private func detailTile(title: String, value: String, tone: DetailTone = .neutral) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tone.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassSurface()
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: 12) {
            WatchlistButton(
                slug: card.id,
                cardName: card.name,
                setName: card.setName
            )

            Spacer()

            Button {
                PAHaptics.tap()
                showAddHolding = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .semibold))
                    Text("Add to Collection")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(PA.Colors.background)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(PA.Colors.accent)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - AI Brief

    @ViewBuilder
    private var aiBriefSection: some View {
        if let profile = cardProfile {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                    Text("AI Brief")
                        .font(PA.Typography.sectionTitle)
                        .foregroundStyle(PA.Colors.text)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(profile.summaryShort)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(PA.Colors.text)
                        .lineSpacing(3)

                    if let long = profile.summaryLong {
                        Text(long)
                            .font(.system(size: 13))
                            .foregroundStyle(PA.Colors.muted)
                            .lineSpacing(3)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassSurface()
            }
        }
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
    case neutral, accent, positive, negative

    var color: Color {
        switch self {
        case .neutral: return PA.Colors.text
        case .accent: return PA.Colors.accent
        case .positive: return PA.Colors.positive
        case .negative: return PA.Colors.negative
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
