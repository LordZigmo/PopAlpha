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

// MARK: - Sort Mode

enum SearchSortMode: String, CaseIterable, Identifiable {
    case relevance
    case price = "market-price"
    case newest
    case oldest

    var id: String { rawValue }

    var label: String {
        switch self {
        case .relevance: "Relevance"
        case .price: "Price"
        case .newest: "Newest"
        case .oldest: "Oldest"
        }
    }

    var icon: String {
        switch self {
        case .relevance: "sparkles"
        case .price: "dollarsign.circle"
        case .newest: "clock"
        case .oldest: "clock.arrow.circlepath"
        }
    }
}
