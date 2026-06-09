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
}

struct SearchResponse: Decodable {
    let ok: Bool
    let cards: [SearchCardResult]
}
