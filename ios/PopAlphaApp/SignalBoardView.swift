import SwiftUI
import NukeUI

// MARK: - Signal board shared types
//
// This file used to host `SignalBoardView` (the homepage content surface)
// and a private `AIBriefCard`. Both have been removed: MarketplaceView
// now owns all homepage fetches and renders the sections directly so
// the order can differ between guest and authed flows. AIBriefCard lives
// in its own file (AIBriefCard.swift).
//
// What remains here are the shared low-level types reused across the
// homepage (MarketPulseSection, ForYouRail, Community microfeeds):
//
//   • MoverSection         — eyebrow + 1 featured + N compact rows
//   • FeaturedMoverCard    — large hero row inside MoverSection
//   • CompactMoverRow      — slim row beneath the featured card
//   • ChangePill           — colored "+x.y% 24H" badge
//   • SignalBadgeKind /
//     SignalBadgeView      — HOT / BREAKOUT / WATCH / VALUE chips
//   • formatPrice / formatPct / formatRelativeUpdate — shared formatters
//   • CommunitySection     — "Trending / Most saved / Friends" microfeed

// MARK: - Mover Section — eyebrow + title + 1 featured + compact rows
//
// Exposed as `internal` (drop the `private`) so MarketPulseSection can
// reuse the exact same section template inside its tabbed wrapper.
// Generic over a trailing accessory view so callers can place a
// section-scoped control (e.g. the 24H/7D window toggle) inline with
// the title — keeps the toggle adjacent to the data it switches.

struct MoverSection<TrailingAccessory: View>: View {
    let eyebrow: String
    let eyebrowColor: Color
    let title: String
    let window: SignalWindow?     // nil = non-windowed section
    let cards: [HomepageCardDTO]
    let emptyMessage: String
    let onSelect: (HomepageCardDTO) -> Void
    /// Slugs the current user is watching. Used to render a subtle
    /// "Watchlist spike" rationale chip on the matching rows. Empty set
    /// for guests — no chip is drawn in that case.
    var watchlistSlugs: Set<String> = []
    /// Section-level rationale override. When set, overrides the
    /// per-row badge-derived rationale (e.g. the Unusual tab wants every
    /// row to read "Unusual volume" regardless of each card's badge).
    var sectionRationale: String? = nil
    /// Optional control rendered inline with the title (e.g. window
    /// toggle). Sits between the title and the "See all" link so the
    /// toggle is adjacent to the data it controls.
    let trailingAccessory: () -> TrailingAccessory

    let maxCompactRows: Int

    init(
        eyebrow: String,
        eyebrowColor: Color,
        title: String,
        window: SignalWindow?,
        cards: [HomepageCardDTO],
        emptyMessage: String,
        onSelect: @escaping (HomepageCardDTO) -> Void,
        watchlistSlugs: Set<String> = [],
        sectionRationale: String? = nil,
        maxCompactRows: Int = 4,
        @ViewBuilder trailingAccessory: @escaping () -> TrailingAccessory = { EmptyView() }
    ) {
        self.eyebrow = eyebrow
        self.eyebrowColor = eyebrowColor
        self.title = title
        self.window = window
        self.cards = cards
        self.emptyMessage = emptyMessage
        self.onSelect = onSelect
        self.watchlistSlugs = watchlistSlugs
        self.sectionRationale = sectionRationale
        self.maxCompactRows = maxCompactRows
        self.trailingAccessory = trailingAccessory
    }

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
                trailingAccessory()
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
                            FeaturedMoverCard(
                                card: featured,
                                window: window,
                                rationale: rationale(for: featured)
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    // Compact rows
                    ForEach(Array(cards.dropFirst().prefix(maxCompactRows)), id: \.slug) { card in
                        Button {
                            onSelect(card)
                        } label: {
                            CompactMoverRow(
                                card: card,
                                window: window,
                                rationale: rationale(for: card)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
            }
        }
    }

    /// Derive a one-line rationale for a row: "Watchlist spike" takes
    /// priority (most personal), then any section-level override,
    /// otherwise no chip (the badge already does the work).
    private func rationale(for card: HomepageCardDTO) -> String? {
        if watchlistSlugs.contains(card.slug) { return "Watchlist spike" }
        if let sectionRationale { return sectionRationale }
        return nil
    }
}

// MARK: - Featured Mover Card (96pt)
//
// Exposed as `internal` for reuse by MarketPulseSection / ForYouRail.

struct FeaturedMoverCard: View {
    let card: HomepageCardDTO
    let window: SignalWindow?
    var rationale: String? = nil

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
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(formatPrice(card.marketPrice))
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundStyle(PA.Colors.text)
                        ChangePill(changePct: card.changePct, window: windowLabel)
                    }
                    .fixedSize(horizontal: true, vertical: false)

                    Spacer()

                    if card.sparkline7D.count >= 2 {
                        SparklineView(
                            data: card.sparkline7D,
                            direction: ChangeDirection.from(card.changePct),
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

                // Rationale chip — "why this card is on the page"
                if let rationale {
                    RationaleChip(label: rationale)
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
                LazyImage(url: url) { state in
                    if let image = state.image {
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
        [card.setName, card.displayCardNumberLabel, card.year.map(String.init)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private var windowLabel: String {
        if let window { return window.label }
        return card.changeWindow ?? "24H"
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let priceContext = card.priceContextLabel {
            parts.append(priceContext)
        }
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
//
// Exposed as `internal` for reuse by MarketPulseSection / ForYouRail.

struct CompactMoverRow: View {
    let card: HomepageCardDTO
    let window: SignalWindow?
    var rationale: String? = nil

    var body: some View {
        HStack(spacing: 10) {
            // Image 32x44
            ZStack {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    LazyImage(url: url) { state in
                        if let image = state.image {
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
                    } else if let rationale {
                        // No badge, so surface the rationale chip instead.
                        // Keeps each row to ~52pt without stacking a 3rd line.
                        RationaleChip(label: rationale, compact: true)
                    }
                }
            }

            Spacer(minLength: 4)

            // Sparkline
            if card.sparkline7D.count >= 2 {
                SparklineView(
                    data: card.sparkline7D,
                    direction: ChangeDirection.from(card.changePct),
                    lineWidth: 1.2,
                    height: 20
                )
                .frame(width: 44, height: 20)
            }

            // Price + change
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(formatPrice(card.marketPrice))
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                ChangePill(changePct: card.changePct, window: windowLabel, small: true)
            }
            .fixedSize(horizontal: true, vertical: false)
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
        if let number = card.displayCardNumberLabel {
            parts.append(number)
        }
        if let priceContext = card.priceContextLabel {
            parts.append(priceContext)
        } else if let listings = card.activeListings7D, listings > 0 {
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

struct ChangePill: View {
    let changePct: Double?
    let window: String
    var small: Bool = false

    var body: some View {
        // When there's no change signal, render nothing — a "-- 24H"
        // placeholder reads as broken/loading next to a real price.
        // Same philosophy as `SignalBadgeKind.from` (no badge without
        // a change signal). Important for the JP rail: cards using
        // a Yahoo!JP / Snkrdunk price clear `changePct` because the
        // Scrydex-derived delta doesn't describe their new baseline,
        // and without this guard the row showed "-- 24H" next to the
        // fresh JP price.
        if let pct = changePct {
            let color = ChangeDirection.from(pct).color
            HStack(spacing: 3) {
                Text(formatPct(pct))
                    .font(.system(size: small ? 10 : 11, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Text(window)
                    .font(.system(size: small ? 8 : 9, weight: .semibold))
                    .foregroundStyle(color.opacity(0.75))
                    .lineLimit(1)
            }
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(color)
            .padding(.horizontal, small ? 5 : 6)
            .padding(.vertical, small ? 2 : 3)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        }
    }
}

// MARK: - Signal Badge

enum SignalBadgeKind {
    case hot
    case breakout
    case watch
    case value

    static func from(_ card: HomepageCardDTO) -> SignalBadgeKind? {
        let tier = card.moverTier?.lowercased()
        let direction = card.marketDirection?.lowercased() ?? ""
        // No badge when we have no change signal — don't fabricate one from a zero default.
        guard let change = card.changePct else { return nil }
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

struct SignalBadgeView: View {
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

// MARK: - Shared formatters (internal — reused by MarketPulseSection / ForYouRail)

func formatPrice(_ n: Double?) -> String {
    guard let n, n > 0 else { return "--" }
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 2
    formatter.minimumFractionDigits = 2
    return formatter.string(from: NSNumber(value: n)) ?? String(format: "$%.2f", n)
}

func formatPct(_ n: Double?) -> String {
    guard let n else { return "--" }
    let sign = n > 0 ? "+" : ""
    return "\(sign)\(String(format: "%.1f", n))%"
}

/// Returns a short freshness string like "5m ago", "2h ago", "3d ago"
/// for an ISO8601 timestamp. Returns nil if the timestamp is missing
/// or older than 30 days (not actionable as "fresh").
func formatRelativeUpdate(_ iso: String?) -> String? {
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
//
// Exposed as `internal` so MarketplaceView can render it directly now
// that the SignalBoardView wrapper has been removed.

struct CommunitySection: View {
    let data: HomepageCommunityDTO
    /// When we know the reader's style, reframe the eyebrow to
    /// "COLLECTORS LIKE YOU" so this rail feels socially adjacent
    /// rather than a generic community readout.
    let styleLabel: String?

    /// Defensive opt-in: CommunitySection is hidden in JP mode today,
    /// but the eyebrow brand color reads via `\.market` so a future
    /// re-inclusion stays consistent with the rest of the homepage.
    @Environment(\.market) private var market

    private var eyebrow: String {
        styleLabel == nil ? "COMMUNITY" : "COLLECTORS LIKE YOU"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Section header
            Text(eyebrow)
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(market.accent)
                .padding(.horizontal, PA.Layout.sectionPadding)

            // Trending — horizontal scroll of compact tiles
            if !data.trending.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Trending among collectors")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(PA.Colors.text)
                        .padding(.horizontal, PA.Layout.sectionPadding)
                        .accessibilityAddTraits(.isHeader)

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
                        .accessibilityAddTraits(.isHeader)

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
                        .accessibilityAddTraits(.isHeader)

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

    @Environment(\.market) private var market

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Image
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    LazyImage(url: url) { state in
                        if let image = state.image {
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
                .foregroundStyle(market.accent)
        }
        .frame(width: 100)
    }
}

private struct CommunityListRow: View {
    let card: CommunityCardDTO

    @Environment(\.market) private var market

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(PA.Colors.surfaceSoft)
                if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                    LazyImage(url: url) { state in
                        if let image = state.image {
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
                .foregroundStyle(market.accent)
        }
        .padding(.vertical, 4)
    }
}

private struct FriendEventRow: View {
    let event: FriendEventDTO

    @Environment(\.market) private var market

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 24, height: 24)
                .overlay(
                    Text(String(event.handle.prefix(1)).uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(market.accent)
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

// Previews live with the views they exercise — see MarketplaceView.swift
// for the full home-screen preview, and the individual section files
// (MoverSection used by MarketPulseSection.swift, etc.) for component
// previews. The old SignalBoardView preview that lived here was removed
// when SignalBoardView itself was deleted.
