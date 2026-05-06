import Foundation
import SwiftUI

// MARK: - Change Direction

/// 3-state direction for change percentages: up, down, or flat (exactly 0%).
enum ChangeDirection {
    case up, down, flat

    static func from(_ pct: Double?) -> ChangeDirection {
        guard let p = pct, p != 0 else { return .flat }
        return p > 0 ? .up : .down
    }

    var color: Color {
        switch self {
        case .up:   return PA.Colors.positive
        case .down: return PA.Colors.negative
        case .flat: return PA.Colors.neutral
        }
    }

    /// SF Symbol name for the directional arrow / flat marker.
    var arrowSymbol: String {
        switch self {
        case .up:   return "arrow.up.right"
        case .down: return "arrow.down.right"
        case .flat: return "minus"
        }
    }

    var accessibilityWord: String {
        switch self {
        case .up:   return "up"
        case .down: return "down"
        case .flat: return "unchanged"
        }
    }
}

// MARK: - Marketplace Card Model

struct MarketCard: Identifiable, Hashable {
    let id: String
    let name: String
    let setName: String
    let cardNumber: String
    let price: Double
    /// nil when no metrics row exists for this slug yet — distinct from `0`
    /// (a real, observed flat). Render as "—" rather than "0.0%".
    let changePct: Double?
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
        guard let pct = changePct else { return "—" }
        let sign = pct > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", pct))%"
    }

    var direction: ChangeDirection { ChangeDirection.from(changePct) }

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
            changePct: nil,
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
