import SwiftUI

// MARK: - Signal Board — homepage content surface
//
// Renders the full stack of market-intelligence sections below the
// TodayPulseStrip in MarketplaceView:
//
//   1. AIBriefCard      (Phase 1: static placeholder, Phase 2: /api/homepage/ai-brief)
//   2. Top Movers       (MoverSection: 1 featured + compact rows)
//   3. Breakouts        (from signalBoard.momentum — windowed)
//   4. Unusual Volume   (proxy: highConfidenceMovers — non-windowed Phase 1)
//   5. Pullbacks        (from signalBoard.biggestDrops)
//
// The selected timeframe (24H / 7D) is owned by MarketplaceView and
// passed in as a @Binding so the Today strip's GlobalTimeframeControl
// drives every windowed section uniformly.
//
// Backed by /api/homepage (getHomepageData on the server). No new
// endpoints in Phase 1 — we re-slice existing data only.

struct SignalBoardView: View {
    @Binding var selectedWindow: SignalWindow

    @State private var data: HomepageDataDTO?
    @State private var aiBrief: HomepageAIBriefDTO?
    @State private var community: HomepageCommunityDTO?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var selectedCard: MarketCard?

    var body: some View {
        Group {
            if isLoading && data == nil {
                loadingState
            } else if let error = loadError, data == nil {
                errorState(error)
            } else if let data {
                content(for: data)
            } else {
                emptyState
            }
        }
        .task {
            await load()
        }
        .refreshable {
            await load()
        }
        .navigationDestination(item: $selectedCard) { card in
            CardDetailView(card: card)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(for data: HomepageDataDTO) -> some View {
        VStack(spacing: 24) {
            AIBriefCard(brief: aiBrief, fallbackAsOf: data.asOf)
                .padding(.horizontal, PA.Layout.sectionPadding)

            MoverSection(
                eyebrow: "LIVE MARKET",
                eyebrowColor: PA.Colors.accent,
                title: "Top movers",
                window: selectedWindow,
                cards: data.signalBoard.topMovers.forWindow(selectedWindow),
                emptyMessage: "No \(selectedWindow.label) movers yet",
                onSelect: handleSelect
            )

            // Breakouts: prefer Phase 2 dedicated section, fall back to momentum rail
            MoverSection(
                eyebrow: "BREAKOUTS",
                eyebrowColor: Color(red: 0.486, green: 0.227, blue: 0.929),
                title: "Breakouts",
                window: nil,
                cards: data.signalBoard.breakouts
                    ?? data.signalBoard.momentum.forWindow(selectedWindow),
                emptyMessage: "No breakouts yet",
                onSelect: handleSelect
            )

            // Unusual volume: prefer Phase 2 dedicated section, fall back to high-confidence movers
            MoverSection(
                eyebrow: "UNUSUAL",
                eyebrowColor: PA.Colors.gold,
                title: "Unusual volume",
                window: nil,
                cards: data.signalBoard.unusualVolume ?? data.highConfidenceMovers,
                emptyMessage: "No unusual activity",
                onSelect: handleSelect
            )

            MoverSection(
                eyebrow: "PULLBACKS",
                eyebrowColor: Color(red: 1.0, green: 0.42, blue: 0.42),
                title: "Pullbacks",
                window: selectedWindow,
                cards: data.signalBoard.biggestDrops.forWindow(selectedWindow),
                emptyMessage: "No \(selectedWindow.label) pullbacks",
                onSelect: handleSelect
            )

            // Community rail
            if let community, !(community.trending.isEmpty && community.mostSaved.isEmpty && community.friendsAdded.isEmpty) {
                CommunitySection(data: community)
            }

            // Footer
            if let asOf = data.asOf {
                Text("Data as of \(formatAsOf(asOf)) · Scrydex & PokémonTCG")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView().tint(PA.Colors.accent)
            Text("Loading market signals...")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("Couldn't load signals")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text(message)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .lineLimit(3)
            Button {
                Task { await load() }
            } label: {
                Text("Retry")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(PA.Colors.accent.opacity(0.12))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.horizontal, 32)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("No signals available")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Pull down to refresh")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    // MARK: - Actions

    private func handleSelect(_ card: HomepageCardDTO) {
        PAHaptics.tap()
        selectedCard = card.toMarketCard()
    }

    private func load() async {
        isLoading = true
        loadError = nil
        async let signalTask = CardService.shared.fetchHomepageSignalBoard()
        async let briefTask: HomepageAIBriefDTO? = {
            do { return try await CardService.shared.fetchAIBrief() }
            catch { print("[SignalBoardView] ai-brief load error: \(error)"); return nil }
        }()
        async let communityTask: HomepageCommunityDTO? = {
            do { return try await CardService.shared.fetchHomepageCommunity() }
            catch { print("[SignalBoardView] community load error: \(error)"); return nil }
        }()
        do {
            let fetched = try await signalTask
            let brief = await briefTask
            let comm = await communityTask
            await MainActor.run {
                self.data = fetched
                self.aiBrief = brief
                self.community = comm
                self.isLoading = false
            }
        } catch {
            print("[SignalBoardView] load error: \(error)")
            let brief = await briefTask
            let comm = await communityTask
            await MainActor.run {
                self.aiBrief = brief
                self.community = comm
                self.loadError = error.localizedDescription
                self.isLoading = false
            }
        }
    }

    private func formatAsOf(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let df = DateFormatter()
        df.dateFormat = "h:mm a"
        return df.string(from: date)
    }
}

// MARK: - AI Brief Card

private struct AIBriefCard: View {
    let brief: HomepageAIBriefDTO?
    let fallbackAsOf: String?

    // Placeholder copy used only when the /api/homepage/ai-brief cache is
    // empty (e.g. fresh deploy, cron hasn't run yet). Real briefs come
    // from Gemini via the hourly cron.
    private static let placeholderSummary = "Your AI market brief will appear here once today's data is in. It summarizes where strength is concentrating and which sets are leading the board."
    private static let placeholderTakeaway = "Updating shortly"

    private var summary: String { brief?.summary ?? Self.placeholderSummary }
    private var takeaway: String { brief?.takeaway ?? Self.placeholderTakeaway }
    private var isLive: Bool { brief != nil && brief?.source != "fallback" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header row
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                    Text("AI BRIEF")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(2.0)
                        .foregroundStyle(PA.Colors.accent)
                }
                Circle()
                    .fill(isLive ? PA.Colors.positive : PA.Colors.muted)
                    .frame(width: 5, height: 5)
                Text(timestampLabel)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                Spacer()
            }

            // Body summary
            Text(summary)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.text)
                .lineSpacing(3)
                .lineLimit(3)
                .multilineTextAlignment(.leading)

            // Takeaway chip + read more
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Text("🔥")
                        .font(.system(size: 11))
                    Text(takeaway)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(PA.Colors.accent.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(PA.Colors.accent.opacity(0.2), lineWidth: 0.5)
                )

                Spacer()

                Button {
                    // Phase 2: push full AI brief detail view
                    PAHaptics.tap()
                } label: {
                    HStack(spacing: 4) {
                        Text("Read more")
                            .font(.system(size: 12, weight: .semibold))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(PA.Colors.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                PA.Gradients.cardSurface
                // subtle accent glow top-left
                RadialGradient(
                    colors: [PA.Colors.accent.opacity(0.12), .clear],
                    center: .topLeading,
                    startRadius: 0,
                    endRadius: 220
                )
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
                .stroke(PA.Colors.borderLight, lineWidth: 1)
        )
    }

    private var timestampLabel: String {
        let source = brief?.generatedAt ?? fallbackAsOf
        guard let source else { return "Updating" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: source) ?? ISO8601DateFormatter().date(from: source)
        guard let date else { return "Updating" }
        let minutes = Int(-date.timeIntervalSinceNow / 60)
        if minutes < 1 { return "Updated just now" }
        if minutes < 60 { return "Updated \(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "Updated \(hours)h ago" }
        return "Updated \(hours / 24)d ago"
    }
}

// MARK: - Mover Section — eyebrow + title + 1 featured + compact rows

private struct MoverSection: View {
    let eyebrow: String
    let eyebrowColor: Color
    let title: String
    let window: SignalWindow?     // nil = non-windowed section
    let cards: [HomepageCardDTO]
    let emptyMessage: String
    let onSelect: (HomepageCardDTO) -> Void

    private let maxCompactRows = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(eyebrow)
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(2.0)
                        .foregroundStyle(eyebrowColor)
                    Text(title)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                }
                Spacer(minLength: 8)
                if cards.count > (1 + maxCompactRows) {
                    Button {
                        // Phase 2: navigation to full section view
                        PAHaptics.tap()
                    } label: {
                        Text("See all")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PA.Colors.textSecondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)

            if cards.isEmpty {
                HStack {
                    Spacer()
                    Text(emptyMessage)
                        .font(.system(size: 13))
                        .foregroundStyle(PA.Colors.muted)
                    Spacer()
                }
                .frame(height: 64)
                .padding(.horizontal, PA.Layout.sectionPadding)
            } else {
                VStack(spacing: 8) {
                    // Featured
                    if let featured = cards.first {
                        Button {
                            onSelect(featured)
                        } label: {
                            FeaturedMoverCard(card: featured, window: window)
                        }
                        .buttonStyle(.plain)
                    }

                    // Compact rows
                    ForEach(Array(cards.dropFirst().prefix(maxCompactRows)), id: \.slug) { card in
                        Button {
                            onSelect(card)
                        } label: {
                            CompactMoverRow(card: card, window: window)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
            }
        }
    }
}

// MARK: - Featured Mover Card (96pt)

private struct FeaturedMoverCard: View {
    let card: HomepageCardDTO
    let window: SignalWindow?

    var body: some View {
        HStack(spacing: 12) {
            // Image
            thumbnail
                .frame(width: 72, height: 100)

            // Right side
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.name)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(PA.Colors.text)
                            .lineLimit(1)
                        Text(subtitleText)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(PA.Colors.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if let badge = SignalBadgeKind.from(card) {
                        SignalBadgeView(kind: badge)
                    }
                }

                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(formatPrice(card.marketPrice))
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundStyle(PA.Colors.text)
                        ChangePill(changePct: card.changePct, window: windowLabel)
                    }

                    Spacer()

                    if card.sparkline7D.count >= 2 {
                        SparklineView(
                            data: card.sparkline7D,
                            isPositive: (card.changePct ?? 0) >= 0,
                            lineWidth: 1.5,
                            height: 28
                        )
                        .frame(width: 84, height: 28)
                    }
                }

                // Phase 2 density metrics row
                if let meta = metaLine {
                    Text(meta)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PA.Gradients.cardSurface)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous)
                .stroke(PA.Colors.borderLight, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.102, green: 0.102, blue: 0.180),
                            Color(red: 0.039, green: 0.039, blue: 0.071)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                AsyncImage(url: url) { phase in
                    if case let .success(image) = phase {
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .shadow(color: .black.opacity(0.5), radius: 6, x: 0, y: 4)
                    }
                }
                .padding(4)
            }
        }
    }

    private var subtitleText: String {
        [card.setName, card.year.map(String.init)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private var windowLabel: String {
        if let window { return window.label }
        return card.changeWindow ?? "24H"
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let listings = card.activeListings7D, listings > 0 {
            parts.append("\(listings) listings")
        }
        if let sales = card.salesCount30D, sales > 0 {
            parts.append("\(sales) trades/30d")
        }
        if let fresh = formatRelativeUpdate(card.updatedAt) {
            parts.append(fresh)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Compact Mover Row (~52pt)

private struct CompactMoverRow: View {
    let card: HomepageCardDTO
    let window: SignalWindow?

    var body: some View {
        HStack(spacing: 10) {
            // Image 32x44
            ZStack {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    AsyncImage(url: url) { phase in
                        if case let .success(image) = phase {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                        }
                    }
                    .padding(2)
                }
            }
            .frame(width: 32, height: 44)

            // Name / sub
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(compactSubtitle)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                        .lineLimit(1)
                    if let badge = SignalBadgeKind.from(card) {
                        SignalBadgeView(kind: badge, compact: true)
                    }
                }
            }

            Spacer(minLength: 4)

            // Sparkline
            if card.sparkline7D.count >= 2 {
                SparklineView(
                    data: card.sparkline7D,
                    isPositive: (card.changePct ?? 0) >= 0,
                    lineWidth: 1.2,
                    height: 20
                )
                .frame(width: 44, height: 20)
            }

            // Price + change
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatPrice(card.marketPrice))
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                ChangePill(changePct: card.changePct, window: windowLabel, small: true)
            }
            .frame(minWidth: 64, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity)
        .background(PA.Colors.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var subtitleText: String {
        [card.setName, card.year.map(String.init)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    // Compact rows prefer density metrics over year, since the tile is
    // short on horizontal space. Shows set · (listings or trades).
    private var compactSubtitle: String {
        var parts: [String] = []
        if let set = card.setName, !set.isEmpty { parts.append(set) }
        if let listings = card.activeListings7D, listings > 0 {
            parts.append("\(listings) listings")
        } else if let sales = card.salesCount30D, sales > 0 {
            parts.append("\(sales) trades")
        } else if let year = card.year {
            parts.append(String(year))
        }
        return parts.joined(separator: " · ")
    }

    private var windowLabel: String {
        if let window { return window.label }
        return card.changeWindow ?? "24H"
    }
}

// MARK: - Change Pill

private struct ChangePill: View {
    let changePct: Double?
    let window: String
    var small: Bool = false

    var body: some View {
        let value = changePct ?? 0
        let isPositive = value >= 0
        let color: Color = isPositive ? PA.Colors.positive : PA.Colors.negative
        HStack(spacing: 3) {
            Text(formatPct(changePct))
                .font(.system(size: small ? 10 : 11, weight: .bold, design: .rounded))
            Text(window)
                .font(.system(size: small ? 8 : 9, weight: .semibold))
                .foregroundStyle(color.opacity(0.75))
        }
        .foregroundStyle(color)
        .padding(.horizontal, small ? 5 : 6)
        .padding(.vertical, small ? 2 : 3)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

// MARK: - Signal Badge

private enum SignalBadgeKind {
    case hot
    case breakout
    case watch
    case value

    static func from(_ card: HomepageCardDTO) -> SignalBadgeKind? {
        let tier = card.moverTier?.lowercased()
        let direction = card.marketDirection?.lowercased() ?? ""
        let change = card.changePct ?? 0
        if tier == "hot" && change > 0 {
            return direction.contains("up") || direction.contains("rising") ? .breakout : .hot
        }
        if tier == "warming" && change > 0 {
            return .watch
        }
        if (card.confidenceScore ?? 0) >= 80 && change < -2 {
            return .value
        }
        return nil
    }

    var label: String {
        switch self {
        case .hot: return "HOT"
        case .breakout: return "BREAKOUT"
        case .watch: return "WATCH"
        case .value: return "VALUE"
        }
    }

    var color: Color {
        switch self {
        case .hot: return Color(red: 1.0, green: 0.42, blue: 0.18)        // #FF6B2E
        case .breakout: return Color(red: 0.486, green: 0.227, blue: 0.929)
        case .watch: return PA.Colors.accent
        case .value: return PA.Colors.positive
        }
    }
}

private struct SignalBadgeView: View {
    let kind: SignalBadgeKind
    var compact: Bool = false

    var body: some View {
        Text(kind.label)
            .font(.system(size: compact ? 8 : 9, weight: .bold))
            .tracking(compact ? 0.6 : 1.0)
            .foregroundStyle(kind.color)
            .padding(.horizontal, compact ? 5 : 6)
            .padding(.vertical, compact ? 1 : 3)
            .background(kind.color.opacity(0.15))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(kind.color.opacity(0.3), lineWidth: 0.5)
            )
    }
}

// MARK: - Shared formatters

private func formatPrice(_ n: Double?) -> String {
    guard let n, n > 0 else { return "--" }
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 2
    formatter.minimumFractionDigits = 2
    return formatter.string(from: NSNumber(value: n)) ?? String(format: "$%.2f", n)
}

private func formatPct(_ n: Double?) -> String {
    guard let n else { return "--" }
    let sign = n >= 0 ? "+" : ""
    return "\(sign)\(String(format: "%.1f", n))%"
}

/// Returns a short freshness string like "5m ago", "2h ago", "3d ago"
/// for an ISO8601 timestamp. Returns nil if the timestamp is missing
/// or older than 30 days (not actionable as "fresh").
private func formatRelativeUpdate(_ iso: String?) -> String? {
    guard let iso else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return nil }
    let delta = -date.timeIntervalSinceNow
    if delta < 60 { return "just now" }
    if delta < 3600 { return "\(Int(delta / 60))m ago" }
    if delta < 86_400 { return "\(Int(delta / 3600))h ago" }
    let days = Int(delta / 86_400)
    if days > 30 { return nil }
    return "\(days)d ago"
}

// MARK: - Community Section

private struct CommunitySection: View {
    let data: HomepageCommunityDTO

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Section header
            Text("COMMUNITY")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.accent)
                .padding(.horizontal, PA.Layout.sectionPadding)

            // Trending — horizontal scroll of compact tiles
            if !data.trending.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Trending among collectors")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                        .padding(.horizontal, PA.Layout.sectionPadding)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(data.trending, id: \.slug) { card in
                                CommunityTrendingTile(card: card)
                            }
                        }
                        .padding(.horizontal, PA.Layout.sectionPadding)
                    }
                }
            }

            // Most saved — compact list
            if !data.mostSaved.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Most saved this week")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(PA.Colors.text)

                    ForEach(data.mostSaved.prefix(5), id: \.slug) { card in
                        CommunityListRow(card: card)
                    }
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
            }

            // Friends added — microfeed
            if !data.friendsAdded.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Friends")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(PA.Colors.text)

                    ForEach(Array(data.friendsAdded.prefix(5).enumerated()), id: \.offset) { _, event in
                        FriendEventRow(event: event)
                    }
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
            }
        }
    }
}

private struct CommunityTrendingTile: View {
    let card: CommunityCardDTO

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Image
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    AsyncImage(url: url) { phase in
                        if case let .success(image) = phase {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                    .padding(4)
                }
            }
            .frame(width: 100, height: 140)

            Text(card.name)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)

            Text(card.metricLabel)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.accent)
        }
        .frame(width: 100)
    }
}

private struct CommunityListRow: View {
    let card: CommunityCardDTO

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    AsyncImage(url: url) { phase in
                        if case let .success(image) = phase {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                        }
                    }
                    .padding(2)
                }
            }
            .frame(width: 28, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(card.name)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)
                if let set = card.setName {
                    Text(set)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 4)

            Text(card.metricLabel)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
        }
        .padding(.vertical, 4)
    }
}

private struct FriendEventRow: View {
    let event: FriendEventDTO

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 24, height: 24)
                .overlay(
                    Text(String(event.handle.prefix(1)).uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(PA.Colors.accent)
                )

            Text(eventText)
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineLimit(1)

            Spacer(minLength: 4)

            Text(relativeTime)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(.vertical, 2)
    }

    private var eventText: String {
        let card = event.cardName ?? "a card"
        return "**\(event.handle)** \(event.action) \(card)"
    }

    private var relativeTime: String {
        formatRelativeUpdate(event.createdAt) ?? ""
    }
}

// MARK: - Preview

#Preview("Signal Board") {
    StatefulPreviewWrapper(SignalWindow.h24) { binding in
        ScrollView {
            SignalBoardView(selectedWindow: binding)
        }
        .background(PA.Colors.background)
        .preferredColorScheme(.dark)
    }
}

private struct StatefulPreviewWrapper<Value, Content: View>: View {
    @State var value: Value
    var content: (Binding<Value>) -> Content
    init(_ value: Value, @ViewBuilder content: @escaping (Binding<Value>) -> Content) {
        self._value = State(initialValue: value)
        self.content = content
    }
    var body: some View { content($value) }
}
