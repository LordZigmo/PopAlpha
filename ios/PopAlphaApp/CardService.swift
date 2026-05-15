import Foundation
import OSLog

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
        Logger.api.debug("Fetched \(metrics.count) metrics rows")

        guard !slugs.isEmpty else {
            Logger.api.debug("No metrics rows matched filters — returning empty")
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
        Logger.api.debug("Fetched \(cards.count) card metadata rows")
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
        Logger.api.debug("Fetched \(images.count) image rows")
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
                changePct: changePct,
                changeWindow: m.changePct24h != nil ? "24H" : "7D",
                rarity: classifyRarity(price: price, listings: m.activeListings7d),
                sparkline: sparkline.isEmpty ? [price] : sparkline,
                imageGradient: [GradientStop(r: 0.1, g: 0.05, b: 0.15), GradientStop(r: 0.2, g: 0.1, b: 0.3)],
                imageURL: imageMap[m.canonicalSlug].flatMap(URL.init(string:)),
                confidenceScore: m.marketConfidenceScore
            )
        }
        Logger.api.debug("Assembled \(result.count) MarketCards")
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

    /// Fetch graded price history for a (provider, bucket) cohort across
    /// all printings of a card. Used by the Grade Board chart when no
    /// specific printing is selected.
    ///
    /// price_history_points stores graded variant_refs in the long form
    /// `<printingId>::<providerVariantId>::GRADED::<PROVIDER>::<BUCKET>::RAW`
    /// — six `::`-separated segments ending in `::RAW`. The previous
    /// pattern (`%::PROVIDER::BUCKET`) silently matched zero rows because
    /// graded refs end in `::RAW`, not in the bucket. The corrected
    /// pattern anchors on the `::GRADED::<PROVIDER>::<BUCKET>::RAW` tail.
    func fetchGradedPriceHistory(slug: String, provider: String, bucket: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))

        let data = try await Supabase.query(
            table: "public_price_history",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("variant_ref", "ilike", "%::GRADED::\(provider)::\(bucket)::RAW"),
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

    /// Fetch per-grade-bucket card_metrics rows for a card. card_metrics is keyed
    /// by (canonical_slug, printing_id, grade) — one row per bucket, aggregate
    /// across providers (no provider column). The Grade Board summary section
    /// uses this to show median/range/sample stats for the selected bucket.
    ///
    /// We fetch ALL graded rows for the slug (both canonical printing_id=NULL
    /// rows and printing-scoped rows) because cards differ in coverage — some
    /// have only canonical, some only printing-scoped, some both. Roughly
    /// 56k of 125k graded rows are canonical, 69k printing-scoped.
    /// CardDetailView picks the best row per bucket: prefer the row matching
    /// the user's selectedPrintingId; fall back to canonical (NULL); fall
    /// back to any row.
    func fetchGradedCardMetrics(slug: String) async throws -> [GradedCardMetricRow] {
        let data = try await Supabase.query(
            table: "public_card_metrics",
            select: "canonical_slug,printing_id,grade,median_7d,median_30d,low_30d,high_30d,trimmed_median_30d,snapshot_count_30d,updated_at",
            filters: [
                ("canonical_slug", "eq", slug),
                ("grade", "in", "(LE_7,G8,G9,G9_5,G10,G10_PERFECT)"),
            ],
            order: "grade.asc",
            limit: 60
        )
        return try decoder.decode([GradedCardMetricRow].self, from: data)
    }

    // MARK: - Card Printings (finish variants)

    func fetchPrintings(slug: String) async throws -> [CardPrintingOption] {
        let data = try await Supabase.query(
            table: "card_printings",
            select: "id,finish,language,edition,stamp",
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

    /// Fetch graded price history for a specific printing + provider + bucket.
    /// Same long-format variant_ref shape as fetchGradedPriceHistory above
    /// (`<printingId>::<providerVariantId>::GRADED::<PROVIDER>::<BUCKET>::RAW`),
    /// just additionally scoped to the printing prefix. Uses ilike rather
    /// than eq because the providerVariantId in the middle of the ref
    /// makes exact-match impossible without round-tripping it from the
    /// API.
    func fetchPrintingGradedPriceHistory(slug: String, printingId: String, provider: String, bucket: String, timeframe: ChartTimeframe) async throws -> [PricePoint] {
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-timeframe.seconds))
        let pattern = "\(printingId)::%::GRADED::\(provider)::\(bucket)::RAW"
        let data = try await Supabase.query(
            table: "public_price_history",
            select: "ts,price",
            filters: [
                ("canonical_slug", "eq", slug),
                ("variant_ref", "ilike", pattern),
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

    /// Fetch the public_card_metrics row for a card.
    ///
    /// When `printingId` is nil, returns the canonical-level row
    /// (`printing_id IS NULL`) — the blended/fallback view. When a
    /// `printingId` is provided, returns the per-printing row. The view
    /// itself COALESCEs per-printing yahoo_jp_* over the canonical
    /// fallback, so a per-printing query that has no per-printing
    /// yahoo data yet still surfaces the canonical-level blended price
    /// — no extra fetch needed on the client side.
    ///
    /// Why this matters now (2026-05-13): yahoo_jp_card_prices became
    /// per-printing in migration 20260513120000. Cards with multiple
    /// printings (HOLO + Reverse Holo, etc.) can have different median
    /// prices per finish. When the user taps a finish pill on the card
    /// detail view, we re-fetch metrics with that printingId so the
    /// hero price reflects the selected finish instead of staying on
    /// the blended canonical median.
    func fetchCardMetrics(slug: String, printingId: String? = nil) async throws -> CardMetricsResult? {
        let printingFilter: (String, String, String) = printingId.map {
            ("printing_id", "eq", $0)
        } ?? ("printing_id", "is", "null")
        let data = try await Supabase.query(
            table: "public_card_metrics",
            select: "canonical_slug,market_price,market_price_as_of,change_pct_24h,change_pct_7d,market_confidence_score,market_low_confidence,median_7d,median_30d,low_30d,high_30d,active_listings_7d,snapshot_count_30d,yahoo_jp_price,yahoo_jp_price_jpy,yahoo_jp_sample_count,yahoo_jp_observed_at,snkrdunk_price,snkrdunk_sample_count,snkrdunk_observed_at,snkrdunk_product_code,canonical_name_native,set_name_native,language",
            filters: [
                ("canonical_slug", "eq", slug),
                ("grade", "eq", "RAW"),
                printingFilter,
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
            select: "signal_label,verdict,chip,summary_short,summary_long",
            filters: [("canonical_slug", "eq", slug)],
            limit: 1
        )
        let rows = try decoder.decode([CardProfileResult].self, from: data)
        return rows.first
    }

    // MARK: - Cross-language pairing
    //
    // Fetches the cross-language partner slug for the CardDetailView
    // EN/JP toggle. Pulls only what the toggle needs from the much
    // larger /api/cards/[slug]/detail payload — pairedSlug +
    // pairedLanguage live under canonical. The full detail endpoint
    // also carries finish groups, graded matrix, and price compare,
    // none of which iOS currently reads (CardDetailView still drives
    // those from direct Supabase queries via fetchPrintings /
    // fetchCardMetrics). Decoding into the partial DTO ignores the
    // rest so server-side additions don't break iOS.
    //
    // Returns CardPairing(nil, nil) when no pairing exists for the
    // slug; callers should treat that as "hide the toggle."

    func fetchCardPairing(slug: String) async throws -> CardPairing {
        let response: CardDetailDTO = try await APIClient.get(
            path: "/api/cards/\(slug)/detail"
        )
        return CardPairing(
            pairedSlug: response.canonical.pairedSlug,
            pairedLanguage: response.canonical.pairedLanguage,
            pairedImageUrl: response.canonical.pairedImageUrl
        )
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

    /// Fetch curated metadata for a set (era, release date, etc.) from
    /// `public.sets`. Returns `nil` if no row exists for the given set_name.
    /// RLS is public-read on the sets table (PR #34 → 20260509130000), so
    /// no auth header beyond the anon key is required.
    func fetchSetMetadata(setName: String) async throws -> SetMetadataRow? {
        let data = try await Supabase.query(
            table: "sets",
            select: "set_name,era,release_date,derived_card_count",
            filters: [("set_name", "eq", setName)],
            limit: 1
        )
        let rows = try decoder.decode([SetMetadataRow].self, from: data)
        return rows.first
    }

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
            // Preserve nil when the metrics row is missing — UI renders "—"
            // rather than fabricating a fake 0%. Only fall through 24h → 7d
            // when the row exists but the 24h column is null.
            let changePct = m?.changePct24h ?? m?.changePct7d
            let changeWindow: String = {
                guard let m else { return "24H" }
                return m.changePct24h != nil ? "24H" : "7D"
            }()

            return MarketCard(
                id: card.slug,
                name: card.canonicalName,
                setName: card.setName ?? setName,
                cardNumber: card.cardNumber.map { "#\($0)" } ?? "",
                price: price,
                changePct: changePct,
                changeWindow: changeWindow,
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

/// Row from `public.sets`. Curated metadata: era + release_date are populated
/// via scripts/backfill-sets-era-release-date.mjs from the Scrydex /expansions
/// API; both may be `nil` for the small tail of sets Scrydex doesn't return
/// (3 today: base-set, pokemon-card-151, xy-evolutions).
struct SetMetadataRow: Decodable {
    let setName: String
    let era: String?
    let releaseDate: String?
    let derivedCardCount: Int?
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
    let signalLabel: String?   // "BREAKOUT" | "COOLING" | "VALUE_ZONE" | "STEADY" | "OVERHEATED"
    let verdict: String?       // "UNDERVALUED" | "FAIR" | "OVERHEATED" | "INSUFFICIENT_DATA"
    let chip: String?          // e.g. "🔥 Breakout Alert"
    let summaryShort: String
    let summaryLong: String?
}

// MARK: - Cross-language pairing DTOs
//
// Partial view of /api/cards/[slug]/detail. We only decode the two
// fields the EN/JP toggle reads; the broader payload (finish groups,
// graded matrix, pricing) is intentionally ignored so server-side
// additions don't break iOS. The active CardDetailView still drives
// finish/grade/price data through the existing Supabase-direct
// queries (fetchPrintings / fetchCardMetrics / fetchConditionPrices).

struct CardDetailDTO: Decodable {
    struct Canonical: Decodable {
        let pairedSlug: String?
        let pairedLanguage: String?
        let pairedImageUrl: String?
    }
    let canonical: Canonical
}

struct CardPairing {
    let pairedSlug: String?
    let pairedLanguage: String?
    /// Mirrored (or raw fallback) image URL for the paired card. Used
    /// to populate the toggle's stub MarketCard so the hero swaps art
    /// directly EN ↔ JP without falling back to heroPlaceholder while
    /// the metrics fetch lands.
    let pairedImageUrl: String?

    static let none = CardPairing(pairedSlug: nil, pairedLanguage: nil, pairedImageUrl: nil)

    /// The language the paired card represents. JP cards toggle to EN
    /// and vice versa; nil when no pairing exists.
    var pairedLang: CardLanguage? {
        switch (pairedLanguage ?? "").uppercased() {
        case "EN": return .en
        case "JP": return .jp
        default: return nil
        }
    }
}

enum CardLanguage: String {
    case en = "EN"
    case jp = "JP"

    var displayLabel: String {
        switch self {
        case .en: return "EN"
        case .jp: return "JP"
        }
    }
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
    /// Japanese-market scraped price columns. Populated by
    /// scripts/run-yahoo-jp-pipeline.mjs from Yahoo! Auctions JP
    /// closed-auction sold listings. Only set on JP-language
    /// canonical_cards. The USD price is the JPY median converted via
    /// the env-configured JPY/USD rate (lib/pricing/fx.ts mirror); the
    /// JPY field is preserved so the UI can display the native price
    /// without re-converting.
    let yahooJpPrice: Double?
    let yahooJpPriceJpy: Double?
    let yahooJpSampleCount: Int?
    let yahooJpObservedAt: String?
    /// Snkrdunk scraped price columns. Populated by
    /// scripts/run-snkrdunk-pipeline.mjs from Snkrdunk's English
    /// /en/v1/products/SW---<id>/used-listings JSON API (only sold
    /// listings, condition=A/B map to RAW; PSA 10 maps to grade=G10).
    /// Second JP-native source after Yahoo! — fills the modern-card
    /// gap where Yahoo!'s vintage strength tapers off. The USD price
    /// is Snkrdunk's own JPY→USD conversion (they serve USD directly
    /// on the English site). product_code is the SW---<id> identifier
    /// used to re-fetch via the cron route.
    let snkrdunkPrice: Double?
    let snkrdunkSampleCount: Int?
    let snkrdunkObservedAt: String?
    let snkrdunkProductCode: String?
    /// Bilingual identity. Populated for JP cards by the Scrydex
    /// /ja/ catalog backfill. iOS uses these to render the bilingual
    /// hero (English on top, Japanese smaller below) and to detect
    /// "this is a JP card" without slug-suffix sniffing.
    let canonicalNameNative: String?
    let setNameNative: String?
    let language: String?
}

struct GradedVariantMetricRow: Decodable {
    let printingId: String?
    let provider: String
    let grade: String
    let providerAsOfTs: String?
    let historyPoints30d: Int?
}

/// Aggregate market summary stats per (slug, grade bucket). Sourced from
/// public_card_metrics — no provider dimension. Powers the Grade Board's
/// "Market Summary" section in graded mode.
struct GradedCardMetricRow: Decodable, Identifiable {
    let canonicalSlug: String
    let printingId: String?
    let grade: String
    let median7d: Double?
    let median30d: Double?
    let low30d: Double?
    let high30d: Double?
    let trimmedMedian30d: Double?
    let snapshotCount30d: Int?
    let updatedAt: String?

    var id: String { "\(canonicalSlug)::\(printingId ?? "null")::\(grade)" }
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
    let stamp: String?

    var finishLabel: String {
        switch finish {
        case "NON_HOLO": return "Regular"
        case "HOLO": return "Holo"
        case "REVERSE_HOLO": return "Reverse Holo"
        case "ALT_HOLO": return "Alt Art"
        default: return "Variant"
        }
    }

    static func stampLabel(_ stamp: String) -> String {
        switch stamp.uppercased() {
        case "POKE_BALL_PATTERN":   return "Poké Ball"
        case "MASTER_BALL_PATTERN": return "Master Ball"
        case "SHADOWLESS":          return "Shadowless"
        default:
            return stamp.split(separator: "_")
                        .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
                        .joined(separator: " ")
        }
    }
}

struct FinishStampVariant: Identifiable, Hashable {
    let printingId: String
    let stamp: String?
    let stampLabel: String
    let edition: String

    var id: String { printingId }
}

struct FinishGroup: Identifiable, Hashable {
    let finish: String
    let finishLabel: String
    let defaultPrintingId: String
    let variants: [FinishStampVariant]

    var id: String { finish }
}

extension Array where Element == CardPrintingOption {
    func toFinishGroups() -> [FinishGroup] {
        let priority: [String: Int] = [
            "NON_HOLO": 0,
            "HOLO": 1,
            "REVERSE_HOLO": 2,
            "ALT_HOLO": 3,
            "UNKNOWN": 4,
        ]
        let labels: [String: String] = [
            "NON_HOLO": "Regular",
            "HOLO": "Holo",
            "REVERSE_HOLO": "Reverse Holo",
            "ALT_HOLO": "Alt Art",
            "UNKNOWN": "Variant",
        ]

        func canonicalFinish(_ value: String) -> String {
            return labels[value] != nil ? value : "UNKNOWN"
        }
        func canonicalEdition(_ value: String?) -> String {
            switch value {
            case "UNLIMITED", "FIRST_EDITION": return value!
            default: return "UNKNOWN"
            }
        }
        func stampVariantLabel(stamp: String?, edition: String) -> String {
            let stampText = stamp.map { CardPrintingOption.stampLabel($0) }
            let isFirstEd = edition == "FIRST_EDITION"
            if let stampText, isFirstEd { return "1st Ed · \(stampText)" }
            if let stampText { return stampText }
            if isFirstEd { return "1st Edition" }
            return "Standard"
        }
        func isStandard(_ row: CardPrintingOption) -> Bool {
            return row.stamp == nil && canonicalEdition(row.edition) == "UNLIMITED"
        }

        var buckets: [String: [CardPrintingOption]] = [:]
        for row in self {
            let finish = canonicalFinish(row.finish)
            buckets[finish, default: []].append(row)
        }

        let orderedFinishes = buckets.keys.sorted {
            (priority[$0] ?? 99) < (priority[$1] ?? 99)
        }

        var groups: [FinishGroup] = []
        for finish in orderedFinishes {
            let bucket = buckets[finish] ?? []
            let sorted = bucket.sorted { lhs, rhs in
                let lhsStandard = isStandard(lhs) ? 0 : 1
                let rhsStandard = isStandard(rhs) ? 0 : 1
                if lhsStandard != rhsStandard { return lhsStandard < rhsStandard }
                let lhsLabel = stampVariantLabel(stamp: lhs.stamp, edition: canonicalEdition(lhs.edition))
                let rhsLabel = stampVariantLabel(stamp: rhs.stamp, edition: canonicalEdition(rhs.edition))
                if lhsLabel != rhsLabel { return lhsLabel < rhsLabel }
                return lhs.id < rhs.id
            }
            let variants: [FinishStampVariant] = sorted.map { row in
                let edition = canonicalEdition(row.edition)
                return FinishStampVariant(
                    printingId: row.id,
                    stamp: row.stamp,
                    stampLabel: stampVariantLabel(stamp: row.stamp, edition: edition),
                    edition: edition
                )
            }
            let standard = sorted.first(where: isStandard)
            guard let defaultId = standard?.id ?? variants.first?.printingId else { continue }
            groups.append(FinishGroup(
                finish: finish,
                finishLabel: labels[finish] ?? "Variant",
                defaultPrintingId: defaultId,
                variants: variants
            ))
        }
        return groups
    }
}

// MARK: - Homepage DTOs (mirror lib/data/homepage.ts HomepageData)

struct HomepageCardDTO: Decodable, Hashable {
    let slug: String
    let name: String
    let setName: String?
    let year: Int?
    /// canonical_cards.card_number — used by CardDetailView's metadata
    /// tile so cards opened via a homepage rail show "#1" instead of
    /// "—". Optional during rollout: server builds before commit
    /// (date) sent HomepageCard without this field; older clients
    /// keep decoding cleanly because the converter falls back to "".
    let cardNumber: String?
    /// Mutable so the JP-rail transform (`preferringJpSource()`) can
    /// override the Scrydex USD reflection with the Yahoo!JP / Snkrdunk
    /// native price when a JP source qualifies on sample count.
    var marketPrice: Double?
    /// Mutable for the same reason — Scrydex-derived change/window
    /// percentages don't describe a JP-source price baseline, so the
    /// JP transform clears them rather than show a misleading delta.
    var changePct: Double?
    var changeWindow: String?            // "24H" | "7D"
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
    /// Native JP price sources surfaced on the JP homepage rail. Server
    /// emits these from `public_card_metrics.yahoo_jp_price` /
    /// `public_card_metrics.snkrdunk_price` (see lib/data/homepage.ts
    /// `loadJapaneseRail`). All four nullable — most non-JP cards
    /// won't carry them. Selection rule mirrors the web's
    /// `lib/pricing/jp-price-source.ts`: require sample_count ≥ 3, pick
    /// the source with more samples when both qualify.
    let yahooJpPrice: Double?
    let yahooJpSampleCount: Int?
    let snkrdunkPrice: Double?
    let snkrdunkSampleCount: Int?

    /// Best URL for small card cells — mirrored thumb when present,
    /// otherwise the full image URL.
    var displayThumbUrl: String? {
        imageThumbUrl ?? imageUrl
    }

    /// When this card carries a qualifying Yahoo!JP or Snkrdunk price,
    /// return a copy whose `marketPrice` is the JP-source price and
    /// whose Scrydex-derived `changePct` / `changeWindow` are cleared
    /// (those describe Scrydex's USD reflection, not the Yahoo/Snkrdunk
    /// baseline we're now showing). Returns `self` unchanged when no
    /// JP source qualifies — the row then falls back to the Scrydex
    /// USD reflection it would have shown without the toggle.
    ///
    /// Used by the JP-only rail rendering so the JP market view
    /// actually shows JP-market pricing instead of the global USD
    /// reflection. Matches the web's `selectJpPriceSource` rule in
    /// `lib/pricing/jp-price-source.ts`.
    func preferringJpSource() -> HomepageCardDTO {
        let pick = selectJpPriceSource(
            yahooJpPrice: yahooJpPrice,
            yahooJpSampleCount: yahooJpSampleCount,
            snkrdunkPrice: snkrdunkPrice,
            snkrdunkSampleCount: snkrdunkSampleCount
        )
        guard let jpPrice = pick.price else { return self }
        var copy = self
        copy.marketPrice = jpPrice
        copy.changePct = nil
        copy.changeWindow = nil
        return copy
    }
}

/// Source picked for a JP card's tile-level price. Mirrors the web's
/// `JpPriceSource` type from `lib/pricing/jp-price-source.ts`.
enum JpPriceSourceKind: String {
    case snkrdunk
    case yahooJp
}

struct JpPriceSourcePick {
    let source: JpPriceSourceKind?
    let price: Double?
    let sampleCount: Int?
    let label: String
}

/// Swift port of `selectJpPriceSource` in lib/pricing/jp-price-source.ts.
/// Keep in lockstep with the web rule so iOS rails and web tiles tell
/// the same per-source story.
///
/// Rule: a source qualifies when price > 0 AND sample_count ≥ 3. If
/// both qualify, pick the higher sample count. If only one qualifies,
/// pick that. Otherwise return a nil pick — the caller falls back to
/// the Scrydex `market_price`.
func selectJpPriceSource(
    yahooJpPrice: Double?,
    yahooJpSampleCount: Int?,
    snkrdunkPrice: Double?,
    snkrdunkSampleCount: Int?
) -> JpPriceSourcePick {
    let minSamples = 3
    let yj = (yahooJpPrice ?? 0) > 0 ? (yahooJpPrice ?? 0) : 0
    let snk = (snkrdunkPrice ?? 0) > 0 ? (snkrdunkPrice ?? 0) : 0
    let yjN = yahooJpSampleCount ?? 0
    let snkN = snkrdunkSampleCount ?? 0
    let yjQualifies = yj > 0 && yjN >= minSamples
    let snkQualifies = snk > 0 && snkN >= minSamples

    if yjQualifies && snkQualifies {
        return snkN > yjN
            ? JpPriceSourcePick(source: .snkrdunk, price: snk, sampleCount: snkN, label: "Snkrdunk")
            : JpPriceSourcePick(source: .yahooJp, price: yj, sampleCount: yjN, label: "Yahoo! JP")
    }
    if snkQualifies {
        return JpPriceSourcePick(source: .snkrdunk, price: snk, sampleCount: snkN, label: "Snkrdunk")
    }
    if yjQualifies {
        return JpPriceSourcePick(source: .yahooJp, price: yj, sampleCount: yjN, label: "Yahoo! JP")
    }
    return JpPriceSourcePick(source: nil, price: nil, sampleCount: nil, label: "")
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
    // Three-tier price segmentation (server migration 20260504230000):
    //   premium ≥ $50 → top_movers / biggest_drops / momentum (windowed)
    //   mid $8..$50   → mid_movers (gainers, non-windowed)
    //   budget $1..$8 → budget_movers (gainers, non-windowed)
    // Both mid and budget are optional so older server builds still decode.
    let midMovers: [HomepageCardDTO]?
    let budgetMovers: [HomepageCardDTO]?
    // JP catalog discovery rail (commit dbef009 / 2026-05-07). Non-
    // windowed, sorted server-side by snapshot freshness. Optional
    // so older server builds without /ja/ ingestion still decode.
    let japanese: [HomepageCardDTO]?
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
    /// Labeled 3-step content. Optional for backward compat with
    /// briefs cached before the 3-step migration. The card falls
    /// back to the single `summary` blob if these are nil.
    let whatsHappening: String?
    let whyItMatters: String?
    let whatToWatch: String?
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
        // Prefix with "#" to match the rest of the iOS conversion paths
        // (CardService.fetchMarketCards / fetchSetCards both stamp this
        // before handing the row to CardDetailView). Empty string when
        // the API response is missing the field (older server builds).
        let displayCardNumber: String = {
            guard let raw = cardNumber?.trimmingCharacters(in: .whitespaces),
                  !raw.isEmpty else { return "" }
            return raw.hasPrefix("#") ? raw : "#\(raw)"
        }()
        return MarketCard(
            id: slug,
            name: name,
            setName: setName ?? "Unknown",
            cardNumber: displayCardNumber,
            price: price,
            changePct: changePct,
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
