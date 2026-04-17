import Foundation

// MARK: - Marketplace Card Model

struct MarketCard: Identifiable, Hashable {
    let id: String
    let name: String
    let setName: String
    let cardNumber: String
    let price: Double
    let changePct: Double
    let changeWindow: String
    let rarity: CardRarity
    let sparkline: [Double]
    let imageGradient: [GradientStop]
    let imageURL: URL?
    let confidenceScore: Int?

    var formattedPrice: String {
        if price >= 1000 {
            return String(format: "$%.0f", price)
        }
        return String(format: "$%.2f", price)
    }

    var changeText: String {
        let sign = changePct >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", changePct))%"
    }

    var isPositive: Bool { changePct >= 0 }

    var confidenceLabel: ConfidenceLevel? {
        guard let score = confidenceScore else { return nil }
        if score >= 85 { return .high }
        if score >= 70 { return .solid }
        if score >= 55 { return .watch }
        return .low
    }
    /// Lightweight stub for navigation from search results.
    /// The detail view loads full metrics on appear.
    static func stub(slug: String, name: String = "", setName: String = "", cardNumber: String = "", imageURL: URL? = nil) -> MarketCard {
        MarketCard(
            id: slug,
            name: name,
            setName: setName,
            cardNumber: cardNumber,
            price: 0,
            changePct: 0,
            changeWindow: "24H",
            rarity: .common,
            sparkline: [],
            imageGradient: [],
            imageURL: imageURL,
            confidenceScore: nil
        )
    }
}

enum ConfidenceLevel {
    case high, solid, watch, low

    var label: String {
        switch self {
        case .high: return "High"
        case .solid: return "Solid"
        case .watch: return "Watch"
        case .low: return "Low"
        }
    }

    var segments: Int {
        switch self {
        case .high: return 4
        case .solid: return 3
        case .watch: return 2
        case .low: return 1
        }
    }
}

enum CardRarity: String {
    case common, uncommon, rare, ultraRare, secretRare

    var label: String {
        switch self {
        case .common: return "Common"
        case .uncommon: return "Uncommon"
        case .rare: return "Rare"
        case .ultraRare: return "Ultra Rare"
        case .secretRare: return "Secret Rare"
        }
    }
}

struct GradientStop: Hashable {
    let r: Double, g: Double, b: Double
}
