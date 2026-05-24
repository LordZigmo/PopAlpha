import SwiftUI
import NukeUI
import OSLog

// MARK: - Set Browser
//
// Displays all cards in a given set sorted by price (desc), with card
// images, name, number, and current RAW price. Tapping a card pushes
// the card detail view. Mirrors the web `/sets/[setName]` page.

struct SetDetailView: View {
    let setName: String

    @Environment(\.dismiss) private var dismiss
    @State private var cards: [MarketCard] = []
    @State private var metadata: SetMetadataRow?
    @State private var setSummary: SetSummarySnapshotRow?
    @State private var finishSummary: [SetFinishSummaryRow] = []
    @State private var loading = true
    @State private var selectedCard: MarketCard?

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 16) {
                header

                if loading {
                    loadingState
                } else if cards.isEmpty {
                    emptyState
                } else {
                    if let digest = marketDigest {
                        SetMarketOverviewCard(digest: digest) { card in
                            PAHaptics.tap()
                            selectedCard = card
                        }
                    }

                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(cards) { card in
                            Button {
                                PAHaptics.tap()
                                selectedCard = card
                            } label: {
                                SetCardCell(card: card)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(PA.Colors.background)
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
        }
        .navigationDestination(item: $selectedCard) { card in
            CardDetailView(card: card)
        }
        // .task(id:) instead of plain .task so the load only fires when
        // setName actually changes (i.e. navigating TO a new set) — NOT
        // on every view re-appear. Without this, popping back from
        // CardDetailView re-runs the task, flips `loading = true` for a
        // frame, body re-renders the loading branch, the grid gets
        // destroyed, and scroll resets to the top. The fix is app-wide:
        // see WatchlistView, PortfolioView, NotificationView, etc.
        .task(id: setName) { await loadSetCards() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(setName)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(PA.Colors.text)

            // Era + release date subtitle (when known). Populated by the
            // scrydex_set_metadata backfill — see scripts/backfill-sets-
            // era-release-date.mjs. ~99% of sets have at least one field.
            if !loading, let metadata, hasEraOrReleaseDate(metadata) {
                HStack(spacing: 6) {
                    if let era = metadata.era, !era.isEmpty {
                        Text(era)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.text)
                    }
                    if metadata.era != nil, !(metadata.era?.isEmpty ?? true),
                       let formattedDate = formatReleaseDate(metadata.releaseDate) {
                        Text("·")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                        Text(formattedDate)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    } else if let formattedDate = formatReleaseDate(metadata.releaseDate) {
                        Text(formattedDate)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }

            if !loading {
                Text("\(cards.count) card\(cards.count == 1 ? "" : "s")")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .padding(.top, 4)
    }

    private func hasEraOrReleaseDate(_ metadata: SetMetadataRow) -> Bool {
        let hasEra = !(metadata.era?.isEmpty ?? true)
        let hasDate = !(metadata.releaseDate?.isEmpty ?? true)
        return hasEra || hasDate
    }

    /// Format a "YYYY-MM-DD" date string as "MMM d, yyyy" (e.g. "Jan 20, 2023").
    /// Returns nil if the input is missing or unparseable.
    private func formatReleaseDate(_ iso: String?) -> String? {
        guard let iso, !iso.isEmpty else { return nil }
        let input = DateFormatter()
        input.dateFormat = "yyyy-MM-dd"
        input.timeZone = TimeZone(identifier: "UTC")
        guard let date = input.date(from: iso) else { return nil }
        let output = DateFormatter()
        output.dateFormat = "MMM d, yyyy"
        return output.string(from: date)
    }

    private var marketDigest: SetMarketDigest? {
        SetMarketDigest(
            cards: cards,
            metadata: metadata,
            summary: setSummary,
            finishSummary: finishSummary
        )
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 60)
            ProgressView()
                .tint(PA.Colors.accent)
            Text("Loading set...")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer().frame(height: 60)
            Image(systemName: "rectangle.stack")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("No cards found for this set")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Data Loading

    private func loadSetCards() async {
        loading = true
        // Cards and metadata in parallel — both kick off here. We await
        // cards first and flip `loading` off the moment the grid can
        // render, so a slow/hanging metadata fetch can't keep the user
        // staring at a spinner. Metadata is informational only — it
        // populates the header subtitle when it eventually returns.
        metadata = nil
        setSummary = nil
        finishSummary = []
        async let cardsTask = CardService.shared.fetchSetCards(setName: setName)
        async let metadataTask = CardService.shared.fetchSetMetadata(setName: setName)
        async let summaryTask = CardService.shared.fetchSetSummarySnapshot(setName: setName)
        async let finishTask = CardService.shared.fetchSetFinishSummary(setName: setName)

        do {
            cards = try await cardsTask
        } catch {
            Logger.ui.debug("Failed to load set cards: \(error)")
            cards = []
        }
        loading = false

        // Metadata after — failure is non-blocking and never gates render.
        // If setName changes mid-fetch, structured concurrency cancels
        // this await along with the rest of the .task(id:) handler.
        do {
            metadata = try await metadataTask
        } catch {
            Logger.ui.debug("Failed to load set metadata: \(error)")
            metadata = nil
        }

        do {
            setSummary = try await summaryTask
        } catch {
            Logger.ui.debug("Failed to load set summary: \(error)")
            setSummary = nil
        }

        do {
            finishSummary = try await finishTask
        } catch {
            Logger.ui.debug("Failed to load set finish summary: \(error)")
            finishSummary = []
        }
    }
}

// MARK: - Set Market Overview

private struct SetMarketDigest {
    let trackedValue: Double?
    let trackedValueCaption: String
    let totalCards: Int
    let pricedCards: Int
    let coveragePct: Double
    let medianPrice: Double?
    let topChase: MarketCard?
    let topChaseSharePct: Double?
    let trendTitle: String
    let trendDetail: String
    let trendChangePct: Double?
    let heatScore: Double?
    let breakoutCount: Int
    let valueZoneCount: Int
    let bullishCount: Int
    let finishBreakdown: [SetFinishDisplay]
    let strongestMover: SetMoverDisplay?
    let weakestMover: SetMoverDisplay?
    let asOfDate: String?

    init?(
        cards: [MarketCard],
        metadata: SetMetadataRow?,
        summary: SetSummarySnapshotRow?,
        finishSummary: [SetFinishSummaryRow]
    ) {
        guard !cards.isEmpty else { return nil }

        let priced = cards.filter { $0.price > 0 }
        let catalogCount = max(cards.count, metadata?.derivedCardCount ?? 0)
        let localValue = priced.reduce(0) { $0 + $1.price }
        let trustedValue = summary?.marketCap.flatMap { $0 > 0 ? $0 : nil }
        let value = trustedValue ?? (localValue > 0 ? localValue : nil)
        let top = priced.max { $0.price < $1.price }

        self.trackedValue = value
        self.trackedValueCaption = trustedValue != nil ? "Primary RAW rollup" : "Loaded card prices"
        self.totalCards = catalogCount
        self.pricedCards = priced.count
        self.coveragePct = catalogCount > 0 ? Double(priced.count) / Double(catalogCount) : 0
        self.medianPrice = Self.median(priced.map(\.price))
        self.topChase = top
        if let value, value > 0, let top {
            self.topChaseSharePct = (top.price / value) * 100
        } else {
            self.topChaseSharePct = nil
        }

        let trend = Self.trendSummary(
            change7dPct: summary?.change7dPct,
            change30dPct: summary?.change30dPct
        )
        self.trendTitle = trend.title
        self.trendDetail = trend.detail
        self.trendChangePct = trend.changePct
        self.heatScore = summary?.heatScore
        self.breakoutCount = summary?.breakoutCount ?? 0
        self.valueZoneCount = summary?.valueZoneCount ?? 0
        self.bullishCount = summary?.trendBullishCount ?? 0
        self.asOfDate = summary?.asOfDate

        let finishTotal = finishSummary.compactMap(\.cardCount).reduce(0, +)
        self.finishBreakdown = finishSummary
            .filter { ($0.cardCount ?? 0) > 0 }
            .prefix(4)
            .map { row in
                let count = row.cardCount ?? 0
                return SetFinishDisplay(
                    finish: row.finish,
                    cardCount: count,
                    sharePct: finishTotal > 0 ? (Double(count) / Double(finishTotal)) * 100 : 0
                )
            }

        let cardsBySlug = Dictionary(cards.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.strongestMover = Self.moverDisplay(
            from: summary?.topMoversJson,
            cardsBySlug: cardsBySlug,
            direction: .up
        )
        self.weakestMover = Self.moverDisplay(
            from: summary?.topLosersJson,
            cardsBySlug: cardsBySlug,
            direction: .down
        )
    }

    var coverageText: String {
        "\(pricedCards)/\(totalCards)"
    }

    private static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count.isMultiple(of: 2) {
            return (sorted[mid - 1] + sorted[mid]) / 2
        }
        return sorted[mid]
    }

    private static func trendSummary(change7dPct: Double?, change30dPct: Double?) -> (title: String, detail: String, changePct: Double?) {
        if let change = change7dPct {
            if change >= 8 { return ("Rising", "\(SetMarketFormat.signedPercent(change)) over 7D", change) }
            if change >= 2 { return ("Leaning Up", "\(SetMarketFormat.signedPercent(change)) over 7D", change) }
            if change <= -8 { return ("Cooling Off", "\(SetMarketFormat.signedPercent(change)) over 7D", change) }
            if change <= -2 { return ("Softening", "\(SetMarketFormat.signedPercent(change)) over 7D", change) }
            return ("Steady", "\(SetMarketFormat.signedPercent(change)) over 7D", change)
        }
        if let change = change30dPct {
            if change >= 8 { return ("Rising", "\(SetMarketFormat.signedPercent(change)) over 30D", change) }
            if change <= -8 { return ("Cooling Off", "\(SetMarketFormat.signedPercent(change)) over 30D", change) }
            return ("Mixed", "\(SetMarketFormat.signedPercent(change)) over 30D", change)
        }
        return ("Forming", "Not enough recent set data", nil)
    }

    private enum MoverDirection {
        case up, down
    }

    private static func moverDisplay(
        from movers: [SetSummaryMoverRow]?,
        cardsBySlug: [String: MarketCard],
        direction: MoverDirection
    ) -> SetMoverDisplay? {
        let row = (movers ?? [])
            .filter { mover in
                guard let change = mover.change7dPct else { return false }
                return direction == .up ? change > 0 : change < 0
            }
            .first
        guard let row else { return nil }
        let card = cardsBySlug[row.canonicalSlug]
        return SetMoverDisplay(
            title: direction == .up ? "Strongest" : "Weakest",
            cardName: card?.name ?? SetMarketFormat.nameFromSlug(row.canonicalSlug),
            price: row.price,
            change7dPct: row.change7dPct,
            finish: row.finish
        )
    }
}

private struct SetFinishDisplay: Identifiable {
    let finish: String
    let cardCount: Int
    let sharePct: Double

    var id: String { finish }
}

private struct SetMoverDisplay: Identifiable {
    let id = UUID()
    let title: String
    let cardName: String
    let price: Double?
    let change7dPct: Double?
    let finish: String?
}

private struct SetMarketOverviewCard: View {
    let digest: SetMarketDigest
    let onSelectCard: (MarketCard) -> Void

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            LazyVGrid(columns: columns, spacing: 10) {
                SetMetricTile(
                    title: "Coverage",
                    value: digest.coverageText,
                    caption: "\(SetMarketFormat.percent(digest.coveragePct * 100)) priced",
                    tone: digest.coveragePct >= 0.75 ? .accent : .muted
                )
                SetMetricTile(
                    title: "Typical Card",
                    value: SetMarketFormat.compactCurrency(digest.medianPrice),
                    caption: "Median RAW",
                    tone: digest.medianPrice == nil ? .muted : .neutral
                )
                SetMetricTile(
                    title: "Top Share",
                    value: SetMarketFormat.percent(digest.topChaseSharePct),
                    caption: digest.topChase?.name ?? "No chase yet",
                    tone: digest.topChaseSharePct == nil ? .muted : .accent
                )
                SetMetricTile(
                    title: "Heat",
                    value: SetMarketFormat.number(digest.heatScore, digits: 0),
                    caption: "\(digest.breakoutCount) breakouts",
                    tone: (digest.heatScore ?? 0) >= 50 ? .positive : .neutral
                )
            }

            if let topChase = digest.topChase {
                topChaseRow(topChase)
            }

            signalStrip

            if !digest.finishBreakdown.isEmpty {
                finishBreakdown
            }

            if digest.strongestMover != nil || digest.weakestMover != nil {
                moverRows
            }
        }
        .padding(16)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                    Text("Set Market")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(0.4)
                        .textCase(.uppercase)
                        .foregroundStyle(PA.Colors.muted)
                }

                Text(digest.trendTitle)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(PA.Colors.text)

                Text(digest.trendDetail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ChangeDirection.from(digest.trendChangePct).color)
            }

            Spacer(minLength: 10)

            VStack(alignment: .trailing, spacing: 3) {
                Text(SetMarketFormat.compactCurrency(digest.trackedValue))
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.75)
                    .lineLimit(1)
                    .foregroundStyle(PA.Colors.text)
                Text(digest.trackedValueCaption)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .lineLimit(1)
            }
        }
    }

    private func topChaseRow(_ card: MarketCard) -> some View {
        Button {
            onSelectCard(card)
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(PA.Colors.gold.opacity(0.14))
                        .frame(width: 34, height: 34)
                    Image(systemName: "star.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.gold)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Top Chase")
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                        .tracking(0.4)
                        .textCase(.uppercase)
                    Text(card.name)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 2) {
                    Text(card.formattedPrice)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(PA.Colors.accent)
                    if let share = digest.topChaseSharePct {
                        Text("\(SetMarketFormat.percent(share)) of set")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
            }
            .padding(12)
            .background(PA.Colors.surfaceSoft.opacity(0.65))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var signalStrip: some View {
        HStack(spacing: 8) {
            SetSignalPill(title: "Value", value: "\(digest.valueZoneCount)", icon: "scope", tone: .accent)
            SetSignalPill(title: "Bullish", value: "\(digest.bullishCount)", icon: "arrow.up.right", tone: .positive)
            if let asOf = SetMarketFormat.shortDate(digest.asOfDate) {
                SetSignalPill(title: "As Of", value: asOf, icon: "calendar", tone: .muted)
            }
        }
    }

    private var finishBreakdown: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Finish Mix")
                .font(.system(size: 12, weight: .semibold))
                .tracking(0.4)
                .textCase(.uppercase)
                .foregroundStyle(PA.Colors.muted)

            VStack(spacing: 8) {
                ForEach(digest.finishBreakdown) { finish in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            Text(SetMarketFormat.finishLabel(finish.finish))
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(PA.Colors.text)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text("\(finish.cardCount)")
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(PA.Colors.text)
                            Text(SetMarketFormat.percent(finish.sharePct))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(PA.Colors.muted)
                        }

                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(PA.Colors.hairline(0.06))
                                Capsule()
                                    .fill(PA.Colors.accent.opacity(0.7))
                                    .frame(width: max(6, geo.size.width * min(max(finish.sharePct / 100, 0), 1)))
                            }
                        }
                        .frame(height: 5)
                    }
                }
            }
        }
    }

    private var moverRows: some View {
        HStack(spacing: 10) {
            if let mover = digest.strongestMover {
                SetMoverTile(mover: mover, tone: .positive)
            }
            if let mover = digest.weakestMover {
                SetMoverTile(mover: mover, tone: .negative)
            }
        }
    }
}

private enum SetMetricTone {
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

private struct SetMetricTile: View {
    let title: String
    let value: String
    let caption: String
    let tone: SetMetricTone

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .tracking(0.4)
                .textCase(.uppercase)
            Text(value)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(tone.color)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(caption)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(PA.Colors.surfaceSoft.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct SetSignalPill: View {
    let title: String
    let value: String
    let icon: String
    let tone: SetMetricTone

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
            Text(value)
                .font(.system(size: 12, weight: .bold, design: .rounded))
            Text(title)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(tone.color)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity)
        .background(tone.color.opacity(0.10))
        .clipShape(Capsule())
    }
}

private struct SetMoverTile: View {
    let mover: SetMoverDisplay
    let tone: SetMetricTone

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(mover.title)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .tracking(0.4)
                .textCase(.uppercase)
            Text(mover.cardName)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)
            HStack(spacing: 6) {
                Text(SetMarketFormat.compactCurrency(mover.price))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                Text(SetMarketFormat.signedPercent(mover.change7dPct))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tone.color)
            }
            if let finish = mover.finish {
                Text(SetMarketFormat.finishLabel(finish))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(PA.Colors.surfaceSoft.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private enum SetMarketFormat {
    static func compactCurrency(_ value: Double?) -> String {
        guard let value, value > 0, value.isFinite else { return "—" }
        if value >= 1_000_000 {
            return String(format: "$%.1fM", value / 1_000_000)
        }
        if value >= 10_000 {
            return String(format: "$%.0fK", value / 1_000)
        }
        if value >= 1_000 {
            return String(format: "$%.1fK", value / 1_000)
        }
        if value >= 100 {
            return String(format: "$%.0f", value)
        }
        return String(format: "$%.2f", value)
    }

    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.0f%%", value)
    }

    static func signedPercent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let sign = value > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", value))%"
    }

    static func number(_ value: Double?, digits: Int) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.\(digits)f", value)
    }

    static func shortDate(_ isoDate: String?) -> String? {
        guard let isoDate, !isoDate.isEmpty else { return nil }
        let input = DateFormatter()
        input.dateFormat = "yyyy-MM-dd"
        input.timeZone = TimeZone(identifier: "UTC")
        guard let date = input.date(from: isoDate) else { return nil }
        let output = DateFormatter()
        output.dateFormat = "MMM d"
        return output.string(from: date)
    }

    static func finishLabel(_ finish: String) -> String {
        finish
            .replacingOccurrences(of: "_", with: " ")
            .lowercased()
            .split(separator: " ")
            .map { word in word.prefix(1).uppercased() + String(word.dropFirst()) }
            .joined(separator: " ")
    }

    static func nameFromSlug(_ slug: String) -> String {
        slug
            .split(separator: "-")
            .map { word in word.prefix(1).uppercased() + String(word.dropFirst()) }
            .joined(separator: " ")
    }
}

// MARK: - Set Card Cell

private struct SetCardCell: View {
    let card: MarketCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Card image
            ZStack {
                if let url = card.imageURL {
                    LazyImage(url: url) { state in
                        if let image = state.image {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } else if state.error != nil {
                            placeholder
                        } else {
                            placeholder
                                .overlay(ProgressView().tint(PA.Colors.muted))
                        }
                    }
                } else {
                    placeholder
                }
            }
            .aspectRatio(63.0 / 88.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(PA.Colors.border, lineWidth: 1)
            )

            // Name + number
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                Text(card.cardNumber.isEmpty ? "—" : card.cardNumber)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }

            // Price + change
            if card.price > 0 {
                HStack(spacing: 4) {
                    Text(card.formattedPrice)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(PA.Colors.accent)

                    Text(card.changeText)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(card.direction.color)
                }
            } else {
                Text("—")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    private var placeholder: some View {
        Rectangle()
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 20))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            )
    }
}

#Preview("Set Detail") {
    NavigationStack {
        SetDetailView(setName: "Prismatic Evolutions")
    }
}
