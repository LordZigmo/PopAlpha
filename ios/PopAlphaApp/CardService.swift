import Foundation

// MARK: - Card Service — Fetches live data from Supabase

actor CardService {
    static let shared = CardService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: - Trending Cards (Homepage)

    /// Fetch top cards with market price, change%, image, and sparkline
    func fetchTrendingCards() async throws -> [MarketCard] {
        // 1. Fetch metrics rows (cards with prices, sorted by absolute change)
        let metricsData = try await Supabase.query(
            table: "public_card_metrics",
            select: "canonical_slug,market_price,market_price_as_of,change_pct_24h,change_pct_7d,market_confidence_score,market_low_confidence,active_listings_7d,snapshot_count_30d",
            filters: [
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
                ("market_price", "not.is", "null"),
                ("market_price", "gt", "1"),
            ],
            order: "market_price.desc",
            limit: 20
        )
        let metrics = try decoder.decode([MetricsRow].self, from: metricsData)
        let slugs = metrics.map(\.canonicalSlug)
        print("[CardService] Fetched \(metrics.count) metrics rows")

        guard !slugs.isEmpty else {
            print("[CardService] No metrics rows matched filters — returning empty")
            return []
        }

        // 2. Fetch card metadata
        let slugFilter = "(\(slugs.joined(separator: ",")))"
        let cardsData = try await Supabase.query(
            table: "canonical_cards",
            select: "slug,canonical_name,set_name,year,card_number",
            filters: [("slug", "in", slugFilter)]
        )
        let cards = try decoder.decode([CardRow].self, from: cardsData)
        print("[CardService] Fetched \(cards.count) card metadata rows")
        // Use first occurrence if duplicates exist (uniqueKeysWithValues crashes on dupes)
        let cardMap = Dictionary(cards.map { ($0.slug, $0) }, uniquingKeysWith: { first, _ in first })

        // 3. Fetch card images
        let imagesData = try await Supabase.query(
            table: "card_printings",
            select: "canonical_slug,image_url",
            filters: [
                ("canonical_slug", "in", slugFilter),
                ("language", "eq", "EN"),
                ("image_url", "not.is", "null"),
            ],
            limit: 20
        )
        let images = try decoder.decode([ImageRow].self, from: imagesData)
        print("[CardService] Fetched \(images.count) image rows")
        var imageMap: [String: String] = [:]
        for img in images where imageMap[img.canonicalSlug] == nil {
            imageMap[img.canonicalSlug] = img.imageUrl
        }

        // 4. Fetch 7d sparkline data
        let cutoff7d = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7 * 86400))
        let sparkData = try await Supabase.query(
            table: "public_price_history",
            select: "canonical_slug,ts,price",
            filters: [
                ("canonical_slug", "in", slugFilter),
                ("source_window", "eq", "snapshot"),
                ("ts", "gte", cutoff7d),
            ],
            order: "ts.desc",
            limit: 200
        )
        let sparkRows = try decoder.decode([SparklineRow].self, from: sparkData)
        var sparkMap: [String: [Double]] = [:]
        for row in sparkRows {
            var arr = sparkMap[row.canonicalSlug] ?? []
            if arr.count < 7 { arr.append(row.price) }
            sparkMap[row.canonicalSlug] = arr
        }
        // Reverse to oldest→newest
        for (k, v) in sparkMap { sparkMap[k] = v.reversed() }

        // 5. Assemble MarketCard array — always show cards that have a price
        let result = metrics.compactMap { m -> MarketCard? in
            let card = cardMap[m.canonicalSlug]
            let sparkline = sparkMap[m.canonicalSlug] ?? []
            let changePct = m.changePct24h ?? derivePctFromSparkline(sparkline)
            let price = m.marketPrice ?? 0

            return MarketCard(
                id: m.canonicalSlug,
                name: card?.canonicalName ?? m.canonicalSlug,
                setName: card?.setName ?? "Unknown",
                cardNumber: card?.cardNumber.map { "#\($0)" } ?? "",
                price: price,
                changePct: changePct ?? 0,
                changeWindow: m.changePct24h != nil ? "24H" : "7D",
                rarity: classifyRarity(price: price, listings: m.activeListings7d),
                sparkline: sparkline.isEmpty ? [price] : sparkline,
                imageGradient: [GradientStop(r: 0.1, g: 0.05, b: 0.15), GradientStop(r: 0.2, g: 0.1, b: 0.3)],
                imageURL: imageMap[m.canonicalSlug].flatMap(URL.init(string:)),
                confidenceScore: m.marketConfidenceScore
            )
        }
        print("[CardService] Assembled \(result.count) MarketCards")
        return result
    }

    // MARK: - Price History for Chart

    /// Fetch raw-cohort price history for a given timeframe.
    /// Reads from `public_price_history_canonical`, a server-side view that
    /// restricts each slug to a single raw cohort (variant_ref ending in
    /// '::RAW'). This prevents the chart from drawing multiple provider/
    /// finish cohorts as one interleaved zig-zag line — see
    /// supabase/migrations/20260411130000_public_price_history_canonical.sql.
    func fetchPriceHistory(slug: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))

        let data = try await Supabase.query(
            table: "public_price_history_canonical",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("source_window", "eq", "snapshot"),
                ("ts", "gte", cutoff),
            ],
            order: "ts.asc",
            limit: timeframe.maxPoints
        )

        return try decoder.decode([PricePoint].self, from: data)
    }

    /// Fetch graded price history matching a variant_ref suffix pattern.
    /// Used when the user selects a graded pill (e.g. PSA G10).
    /// The suffix is like "::PSA::10" and we match with ilike.
    func fetchGradedPriceHistory(slug: String, variantRef: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))

        let data = try await Supabase.query(
            table: "public_price_history",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("variant_ref", "ilike", "%\(variantRef)"),
                ("source_window", "eq", "snapshot"),
                ("ts", "gte", cutoff),
            ],
            order: "ts.asc",
            limit: timeframe.maxPoints
        )

        return try decoder.decode([PricePoint].self, from: data)
    }

    /// Fetch graded variant metrics from public_variant_metrics for a card.
    func fetchGradedVariantMetrics(slug: String) async throws -> [GradedVariantMetricRow] {
        let data = try await Supabase.query(
            table: "public_variant_metrics",
            select: "printing_id,provider,grade,provider_as_of_ts,history_points_30d",
            filters: [
                ("canonical_slug", "eq", slug),
            ],
            order: "provider.asc,grade.asc",
            limit: 200
        )

        return try decoder.decode([GradedVariantMetricRow].self, from: data)
    }

    // MARK: - Card Printings (finish variants)

    func fetchPrintings(slug: String) async throws -> [CardPrintingOption] {
        let data = try await Supabase.query(
            table: "card_printings",
            select: "id,finish,language,edition",
            filters: [
                ("canonical_slug", "eq", slug),
                ("language", "eq", "EN"),
            ],
            order: "finish.asc",
            limit: 20
        )
        return try decoder.decode([CardPrintingOption].self, from: data)
    }

    /// Fetch condition-based prices (NM, LP, MP, HP, DMG) for a card.
    func fetchConditionPrices(slug: String, printingId: String? = nil) async throws -> [ConditionPriceRow] {
        var filters: [(String, String, String)] = [
            ("canonical_slug", "eq", slug),
        ]
        if let printingId {
            filters.append(("printing_id", "eq", printingId))
        } else {
            filters.append(("printing_id", "is", "null"))
        }
        let data = try await Supabase.query(
            table: "public_card_condition_prices",
            select: "id,condition,price,low_price,high_price,observed_at",
            filters: filters,
            order: "condition.asc",
            limit: 10
        )
        return try decoder.decode([ConditionPriceRow].self, from: data)
            .sorted { $0.sortIndex < $1.sortIndex }
    }

    /// Fetch RAW price history for a specific printing ID.
    /// Reads from public_price_history_by_printing (Phase 2d), which
    /// filters by the backfilled printing_id column — no variant_ref
    /// regex matching, so cohort interleave (e.g. ':normal' +
    /// ':reverseholofoil' under one printing_id) is impossible.
    /// See supabase/migrations/20260423010000_phase2d_canonical_view_v2.sql.
    func fetchPrintingPriceHistory(slug: String, printingId: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))
        let data = try await Supabase.query(
            table: "public_price_history_by_printing",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("printing_id", "eq", printingId),
                ("source_window", "eq", "snapshot"),
                ("ts", "gte", cutoff),
            ],
            order: "ts.asc",
            limit: timeframe.maxPoints
        )
        return try decoder.decode([PricePoint].self, from: data)
    }

    /// Fetch graded price history for a specific printing + provider + grade.
    func fetchPrintingGradedPriceHistory(slug: String, printingId: String, provider: String, bucket: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))
        let variantRef = "\(printingId)::\(provider)::\(bucket)"
        let data = try await Supabase.query(
            table: "public_price_history",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("variant_ref", "eq", variantRef),
                ("source_window", "eq", "snapshot"),
                ("ts", "gte", cutoff),
            ],
            order: "ts.asc",
            limit: timeframe.maxPoints
        )
        return try decoder.decode([PricePoint].self, from: data)
    }

    // MARK: - Prices Refreshed (24h count, matches homepage)

    func fetchPricesRefreshedToday() async throws -> Int {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-24 * 3600))
        return try await Supabase.count(
            table: "public_card_metrics",
            filters: [
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
                ("market_price_as_of", "gte", cutoff),
            ]
        )
    }

    // MARK: - Market Cap (sum of all card market prices)

    func fetchMarketCap() async throws -> Double {
        let data = try await Supabase.query(
            table: "public_card_metrics",
            select: "market_price",
            filters: [
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
                ("market_price", "not.is", "null"),
                ("market_price", "gt", "0"),
            ],
            limit: 10000
        )

        struct Row: Decodable { let marketPrice: Double? }
        let rows = try decoder.decode([Row].self, from: data)
        return rows.compactMap(\.marketPrice).reduce(0, +)
    }

    // MARK: - Average 24h Change (across all priced cards)

    func fetchAvgChange24h() async throws -> Double? {
        // Fetch change_pct_24h for all canonical RAW cards with a price
        let data = try await Supabase.query(
            table: "public_card_metrics",
            select: "change_pct_24h",
            filters: [
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
                ("market_price", "not.is", "null"),
                ("market_price", "gt", "1"),
                ("change_pct_24h", "not.is", "null"),
            ],
            limit: 5000
        )

        struct Row: Decodable { let changePct24h: Double? }
        let rows = try decoder.decode([Row].self, from: data)
        let values = rows.compactMap(\.changePct24h)
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    // MARK: - Card Detail (from metrics)

    func fetchCardMetrics(slug: String) async throws -> CardMetricsResult? {
        let data = try await Supabase.query(
            table: "public_card_metrics",
            select: "canonical_slug,market_price,market_price_as_of,change_pct_24h,change_pct_7d,market_confidence_score,market_low_confidence,median_7d,median_30d,low_30d,high_30d,active_listings_7d,snapshot_count_30d",
            filters: [
                ("canonical_slug", "eq", slug),
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
            ],
            limit: 1
        )
        let rows = try decoder.decode([CardMetricsResult].self, from: data)
        return rows.first
    }

    // MARK: - Card Profile (AI Brief)

    func fetchCardProfile(slug: String) async throws -> CardProfileResult? {
        let data = try await Supabase.query(
            table: "card_profiles",
            select: "summary_short,summary_long",
            filters: [("canonical_slug", "eq", slug)],
            limit: 1
        )
        let rows = try decoder.decode([CardProfileResult].self, from: data)
        return rows.first
    }

    // MARK: - Homepage Signal Board

    /// Fetch the same signal board data the web homepage renders.
    /// Hits /api/homepage which wraps getHomepageData() on the server.
    func fetchHomepageSignalBoard() async throws -> HomepageDataDTO {
        try await APIClient.get(path: "/api/homepage")
    }

    /// Fetch the cached LLM-generated market brief served by
    /// /api/homepage/ai-brief. Returns nil when the cache is empty
    /// (e.g. first deploy, before the cron has populated it).
    func fetchAIBrief() async throws -> HomepageAIBriefDTO? {
        let response: HomepageAIBriefResponseDTO = try await APIClient.get(path: "/api/homepage/ai-brief")
        return response.brief
    }

    /// Fetch the authenticated user's personalized homepage data:
    /// watchlist movers + portfolio summary. Returns nil if the user
    /// is not signed in or the request fails.
    func fetchHomepageMe() async throws -> HomepageMeDTO? {
        guard AuthService.shared.isAuthenticated else { return nil }
        let response: HomepageMeResponseDTO = try await APIClient.get(path: "/api/homepage/me")
        guard response.ok else { return nil }
        return HomepageMeDTO(
            watchlistMovers: response.watchlistMovers ?? [],
            portfolio: response.portfolio
        )
    }

    /// Fetch the homepage community rail: trending cards, most saved
    /// this week, and (if authenticated) friends' recent additions.
    func fetchHomepageCommunity() async throws -> HomepageCommunityDTO {
        let response: HomepageCommunityResponseDTO = try await APIClient.get(path: "/api/homepage/community")
        return HomepageCommunityDTO(
            trending: response.trending ?? [],
            mostSaved: response.mostSaved ?? [],
            friendsAdded: response.friendsAdded ?? []
        )
    }

    // MARK: - Helpers

    private func derivePctFromSparkline(_ points: [Double]) -> Double? {
        guard points.count >= 2, let first = points.first, first > 0 else { return nil }
        return ((points.last! - first) / first) * 100
    }

    private func classifyRarity(price: Double, listings: Int?) -> CardRarity {
        if price >= 200 { return .secretRare }
        if price >= 50 { return .ultraRare }
        if price >= 15 { return .rare }
        return .uncommon
    }

    /// Shared rarity classifier used by MarketCard converters.
    static func classifyRarityForPrice(_ price: Double) -> CardRarity {
        if price >= 200 { return .secretRare }
        if price >= 50 { return .ultraRare }
        if price >= 15 { return .rare }
        return .uncommon
    }

    // MARK: - Set Browser

    /// Fetch all cards in a set with prices and images, sorted by price desc.
    func fetchSetCards(setName: String) async throws -> [MarketCard] {
        // 1. Cards in the set
        let cardsData = try await Supabase.query(
            table: "canonical_cards",
            select: "slug,canonical_name,set_name,year,card_number",
            filters: [("set_name", "eq", setName)],
            order: "card_number.asc",
            limit: 500
        )
        let cards = try decoder.decode([CardRow].self, from: cardsData)
        guard !cards.isEmpty else { return [] }

        let slugs = cards.map(\.slug)
        let slugFilter = "(\(slugs.joined(separator: ",")))"

        // 2. Metrics (prices) + images in parallel
        async let metricsTask: Data = Supabase.query(
            table: "public_card_metrics",
            select: "canonical_slug,market_price,change_pct_24h,change_pct_7d,market_confidence_score",
            filters: [
                ("canonical_slug", "in", slugFilter),
                ("grade", "eq", "RAW"),
                ("printing_id", "is", "null"),
            ],
            limit: 500
        )
        async let imagesTask: Data = Supabase.query(
            table: "card_printings",
            select: "canonical_slug,image_url",
            filters: [
                ("canonical_slug", "in", slugFilter),
                ("language", "eq", "EN"),
                ("image_url", "not.is", "null"),
            ],
            limit: 500
        )

        let metricsData = try await metricsTask
        let imagesData = try await imagesTask

        let metrics = try decoder.decode([MetricsRow].self, from: metricsData)
        let images = try decoder.decode([ImageRow].self, from: imagesData)

        let metricsMap = Dictionary(
            metrics.map { ($0.canonicalSlug, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var imageMap: [String: String] = [:]
        for img in images where imageMap[img.canonicalSlug] == nil {
            imageMap[img.canonicalSlug] = img.imageUrl
        }

        // 3. Assemble and sort by price desc (priced first, then unpriced by number)
        let result = cards.map { card -> MarketCard in
            let m = metricsMap[card.slug]
            let price = m?.marketPrice ?? 0
            let changePct = m?.changePct24h ?? m?.changePct7d ?? 0

            return MarketCard(
                id: card.slug,
                name: card.canonicalName,
                setName: card.setName ?? setName,
                cardNumber: card.cardNumber.map { "#\($0)" } ?? "",
                price: price,
                changePct: changePct,
                changeWindow: m?.changePct24h != nil ? "24H" : "7D",
                rarity: classifyRarity(price: price, listings: nil),
                sparkline: price > 0 ? [price] : [],
                imageGradient: [],
                imageURL: imageMap[card.slug].flatMap(URL.init(string:)),
                confidenceScore: m?.marketConfidenceScore
            )
        }
        .sorted { a, b in
            if a.price > 0 && b.price > 0 { return a.price > b.price }
            if a.price > 0 { return true }
            if b.price > 0 { return false }
            return a.cardNumber.localizedStandardCompare(b.cardNumber) == .orderedAscending
        }

        return result
    }
}

// MARK: - Chart Timeframe

// No 1D case: Scrydex snapshot cadence doesn't produce intraday points.
enum ChartTimeframe: String, CaseIterable {
    case week = "7D"
    case month = "1M"
    case threeMonth = "3M"
    case year = "1Y"

    var seconds: TimeInterval {
        switch self {
        case .week: return 7 * 86400
        case .month: return 30 * 86400
        case .threeMonth: return 90 * 86400
        case .year: return 365 * 86400
        }
    }

    var maxPoints: Int {
        switch self {
        case .week: return 100
        case .month: return 200
        case .threeMonth: return 400
        case .year: return 800
        }
    }
}

// MARK: - API Response Models

struct MetricsRow: Decodable {
    let canonicalSlug: String
    let marketPrice: Double?
    let marketPriceAsOf: String?
    let changePct24h: Double?
    let changePct7d: Double?
    let marketConfidenceScore: Int?
    let marketLowConfidence: Bool?
    let activeListings7d: Int?
    let snapshotCount30d: Int?
}

struct CardRow: Decodable {
    let slug: String
    let canonicalName: String
    let setName: String?
    let year: Int?
    let cardNumber: String?
}

struct ImageRow: Decodable {
    let canonicalSlug: String
    let imageUrl: String?
}

struct SparklineRow: Decodable {
    let canonicalSlug: String
    let ts: String
    let price: Double
}

struct PricePoint: Decodable {
    let ts: String
    let price: Double
}

struct CardProfileResult: Decodable {
    let summaryShort: String
    let summaryLong: String?
}

struct CardMetricsResult: Decodable {
    let canonicalSlug: String
    let marketPrice: Double?
    let marketPriceAsOf: String?
    let changePct24h: Double?
    let changePct7d: Double?
    let marketConfidenceScore: Int?
    let marketLowConfidence: Bool?
    let median7d: Double?
    let median30d: Double?
    let low30d: Double?
    let high30d: Double?
    let activeListings7d: Int?
    let snapshotCount30d: Int?
}

struct GradedVariantMetricRow: Decodable {
    let printingId: String?
    let provider: String
    let grade: String
    let providerAsOfTs: String?
    let historyPoints30d: Int?
}

struct ConditionPriceRow: Decodable, Identifiable {
    let id: String
    let condition: String
    let price: Double
    let lowPrice: Double?
    let highPrice: Double?
    let observedAt: String

    var conditionLabel: String {
        switch condition {
        case "nm": return "Near Mint"
        case "lp": return "Lightly Played"
        case "mp": return "Moderately Played"
        case "hp": return "Heavily Played"
        case "dmg": return "Damaged"
        default: return condition.uppercased()
        }
    }

    static let displayOrder = ["nm", "lp", "mp", "hp", "dmg"]

    var sortIndex: Int {
        Self.displayOrder.firstIndex(of: condition) ?? 99
    }
}

struct CardPrintingOption: Decodable, Identifiable, Hashable {
    let id: String
    let finish: String
    let language: String?
    let edition: String?

    var finishLabel: String {
        switch finish {
        case "NON_HOLO": return "Regular"
        case "HOLO": return "Holo"
        case "REVERSE_HOLO": return "Reverse Holo"
        case "ALT_HOLO": return "Alt Art"
        default: return "Standard"
        }
    }
}

// MARK: - Homepage DTOs (mirror lib/data/homepage.ts HomepageData)

struct HomepageCardDTO: Decodable, Hashable {
    let slug: String
    let name: String
    let setName: String?
    let year: Int?
    let marketPrice: Double?
    let changePct: Double?
    let changeWindow: String?            // "24H" | "7D"
    let confidenceScore: Int?
    let lowConfidence: Bool?
    let marketStrengthScore: Int?
    let marketDirection: String?         // "bullish" | "bearish" | "flat"
    let moverTier: String?               // "hot" | "warming" | "cooling" | "cold"
    let imageUrl: String?
    /// ~256px wide WebP thumbnail served from our Supabase Storage mirror.
    /// Falls back to `imageUrl` for cards the mirror cron hasn't processed yet.
    /// Rail cells should prefer this; detail views continue using `imageUrl`.
    let imageThumbUrl: String?
    let sparkline7D: [Double]
    // Phase 2 density metrics — optional so older cached responses still decode
    let salesCount30D: Int?
    let activeListings7D: Int?
    let updatedAt: String?

    /// Best URL for small card cells — mirrored thumb when present,
    /// otherwise the full image URL.
    var displayThumbUrl: String? {
        imageThumbUrl ?? imageUrl
    }
}

struct HomepageWindowedCardsDTO: Decodable, Hashable {
    let h24: [HomepageCardDTO]
    let d7: [HomepageCardDTO]

    enum CodingKeys: String, CodingKey {
        case h24 = "24H"
        case d7 = "7D"
    }

    func forWindow(_ window: SignalWindow) -> [HomepageCardDTO] {
        switch window {
        case .h24: return h24
        case .d7: return d7
        }
    }
}

struct HomepageSignalBoardDTO: Decodable, Hashable {
    let topMovers: HomepageWindowedCardsDTO
    let biggestDrops: HomepageWindowedCardsDTO
    let momentum: HomepageWindowedCardsDTO
    // Phase 2 conviction signals — non-windowed; optional during rollout
    let unusualVolume: [HomepageCardDTO]?
    let breakouts: [HomepageCardDTO]?
}

struct HomepageDataDTO: Decodable, Hashable {
    let movers: [HomepageCardDTO]
    let highConfidenceMovers: [HomepageCardDTO]
    let emergingMovers: [HomepageCardDTO]
    let losers: [HomepageCardDTO]
    let trending: [HomepageCardDTO]
    let signalBoard: HomepageSignalBoardDTO
    let asOf: String?
    let pricesRefreshedToday: Int?
    let trackedCardsWithLivePrice: Int?
}

enum SignalWindow: String, CaseIterable, Hashable {
    case h24 = "24H"
    case d7 = "7D"

    var label: String { rawValue }
}

// MARK: - Homepage AI Brief DTOs (/api/homepage/ai-brief)

struct HomepageAIBriefDTO: Decodable, Hashable {
    let version: String
    let summary: String
    let takeaway: String
    let focusSet: String?
    let modelLabel: String?
    let source: String?          // "llm" | "fallback"
    let dataAsOf: String?
    let generatedAt: String?
}

struct HomepageAIBriefResponseDTO: Decodable {
    let ok: Bool
    let brief: HomepageAIBriefDTO?
}

// MARK: - Homepage /me DTOs (personalization)

struct WatchlistMoverDTO: Decodable, Hashable {
    let slug: String
    let name: String
    let setName: String?
    let year: Int?
    let marketPrice: Double?
    let changePct: Double?
    let changeWindow: String?
    let imageUrl: String?
    let marketDirection: String?
}

struct PortfolioSummaryDTO: Decodable, Hashable {
    let totalMarketValue: Double
    let totalCostBasis: Double
    let dailyPnlAmount: Double
    let dailyPnlPct: Double?
    let holdingCount: Int
}

struct HomepageMeDTO {
    let watchlistMovers: [WatchlistMoverDTO]
    let portfolio: PortfolioSummaryDTO?
}

struct HomepageMeResponseDTO: Decodable {
    let ok: Bool
    let watchlistMovers: [WatchlistMoverDTO]?
    let portfolio: PortfolioSummaryDTO?
}

// MARK: - Homepage Community DTOs (/api/homepage/community)

struct CommunityCardDTO: Decodable, Hashable {
    let slug: String
    let name: String
    let setName: String?
    let year: Int?
    let imageUrl: String?
    let imageThumbUrl: String?
    let metricValue: Int
    let metricLabel: String

    /// Mirror-preferred small URL for community tiles/rows.
    var displayThumbUrl: String? {
        imageThumbUrl ?? imageUrl
    }
}

struct FriendEventDTO: Decodable, Hashable {
    let handle: String
    let action: String           // "added" | "saved"
    let cardName: String?
    let canonicalSlug: String?
    let createdAt: String
}

struct HomepageCommunityDTO {
    let trending: [CommunityCardDTO]
    let mostSaved: [CommunityCardDTO]
    let friendsAdded: [FriendEventDTO]
}

struct HomepageCommunityResponseDTO: Decodable {
    let ok: Bool
    let trending: [CommunityCardDTO]?
    let mostSaved: [CommunityCardDTO]?
    let friendsAdded: [FriendEventDTO]?
}

// MARK: - DTO → MarketCard converter
// Lets us reuse CardDetailView (which takes a MarketCard) without a parallel UI.

extension HomepageCardDTO {
    func toMarketCard() -> MarketCard {
        let price = marketPrice ?? 0
        let window = changeWindow ?? "24H"
        let sparkline = sparkline7D.isEmpty ? [price] : sparkline7D
        return MarketCard(
            id: slug,
            name: name,
            setName: setName ?? "Unknown",
            cardNumber: "",
            price: price,
            changePct: changePct ?? 0,
            changeWindow: window,
            rarity: CardService.classifyRarityForPrice(price),
            sparkline: sparkline,
            imageGradient: [
                GradientStop(r: 0.1, g: 0.05, b: 0.15),
                GradientStop(r: 0.2, g: 0.1, b: 0.3)
            ],
            imageURL: imageUrl.flatMap(URL.init(string:)),
            confidenceScore: confidenceScore
        )
    }
}
