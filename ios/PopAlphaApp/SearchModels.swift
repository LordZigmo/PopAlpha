import Foundation

// MARK: - Search Models (matches /api/search/cards response)

struct SearchCardResult: Codable, Identifiable, Hashable {
    let canonicalSlug: String
    let canonicalName: String
    let setName: String?
    let cardNumber: String?
    let year: Int?
    let primaryImageUrl: String?
    let score: Double?

    var id: String { canonicalSlug }

    var imageURL: URL? {
        primaryImageUrl.flatMap(URL.init(string:))
    }

    var displayNumber: String? {
        guard let num = cardNumber else { return nil }
        return "#\(num)"
    }

    /// JP vs EN, from the canonical-slug suffix — the same signal the EN/JP
    /// toggle and price resolver use (CardDetailView, MultiScanSession). JP
    /// canonical slugs end in `-jp`; EN slugs don't. Drives the search-result
    /// language pill so a JP printing isn't tapped by mistake.
    var isJapanese: Bool { canonicalSlug.hasSuffix("-jp") }
}

struct SearchResponse: Decodable {
    let ok: Bool
    let cards: [SearchCardResult]
}
