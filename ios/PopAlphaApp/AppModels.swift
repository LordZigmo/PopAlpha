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

// MARK: - Mock Data
// Image URLs from the Pokemon TCG API (publicly available)

enum MockMarket {
    static let trendingCards: [MarketCard] = [
        MarketCard(
            id: "prismatic-evolutions-161-umbreon-ex",
            name: "Umbreon ex",
            setName: "Prismatic Evolutions",
            cardNumber: "#161",
            price: 129.99,
            changePct: 12.4,
            changeWindow: "24H",
            rarity: .secretRare,
            sparkline: [105, 108, 112, 118, 115, 122, 130],
            imageGradient: [GradientStop(r: 0.1, g: 0.05, b: 0.2), GradientStop(r: 0.3, g: 0.1, b: 0.5)],
            imageURL: URL(string: "https://images.pokemontcg.io/sv8pt5/161_hires.png"),
            confidenceScore: 92
        ),
        MarketCard(
            id: "evolving-skies-215-rayquaza-vmax",
            name: "Rayquaza VMAX",
            setName: "Evolving Skies",
            cardNumber: "#215",
            price: 412.00,
            changePct: -2.8,
            changeWindow: "24H",
            rarity: .secretRare,
            sparkline: [430, 425, 420, 418, 415, 410, 412],
            imageGradient: [GradientStop(r: 0.0, g: 0.15, b: 0.1), GradientStop(r: 0.0, g: 0.35, b: 0.25)],
            imageURL: URL(string: "https://images.pokemontcg.io/swsh7/218_hires.png"),
            confidenceScore: 88
        ),
        MarketCard(
            id: "151-199-charizard-ex",
            name: "Charizard ex",
            setName: "151",
            cardNumber: "#199",
            price: 84.50,
            changePct: 5.2,
            changeWindow: "24H",
            rarity: .ultraRare,
            sparkline: [78, 80, 79, 82, 81, 83, 84.5],
            imageGradient: [GradientStop(r: 0.3, g: 0.05, b: 0.0), GradientStop(r: 0.5, g: 0.15, b: 0.0)],
            imageURL: URL(string: "https://images.pokemontcg.io/sv3pt5/199_hires.png"),
            confidenceScore: 95
        ),
        MarketCard(
            id: "team-up-161-magikarp-wailord-gx",
            name: "Magikarp & Wailord-GX",
            setName: "Team Up",
            cardNumber: "#161",
            price: 1049.25,
            changePct: 0.8,
            changeWindow: "7D",
            rarity: .secretRare,
            sparkline: [1020, 1030, 1035, 1040, 1042, 1045, 1049],
            imageGradient: [GradientStop(r: 0.0, g: 0.1, b: 0.25), GradientStop(r: 0.05, g: 0.2, b: 0.4)],
            imageURL: URL(string: "https://images.pokemontcg.io/sm9/161_hires.png"),
            confidenceScore: 78
        ),
        MarketCard(
            id: "surging-sparks-128-pikachu-ex",
            name: "Pikachu ex",
            setName: "Surging Sparks",
            cardNumber: "#128",
            price: 67.25,
            changePct: -1.3,
            changeWindow: "24H",
            rarity: .ultraRare,
            sparkline: [70, 69, 68, 67.5, 68, 67, 67.25],
            imageGradient: [GradientStop(r: 0.35, g: 0.3, b: 0.0), GradientStop(r: 0.5, g: 0.45, b: 0.05)],
            imageURL: URL(string: "https://images.pokemontcg.io/sv8/128_hires.png"),
            confidenceScore: 83
        ),
        MarketCard(
            id: "obsidian-flames-197-charizard-ex",
            name: "Charizard ex",
            setName: "Obsidian Flames",
            cardNumber: "#197",
            price: 156.00,
            changePct: 8.7,
            changeWindow: "24H",
            rarity: .secretRare,
            sparkline: [140, 142, 145, 148, 150, 153, 156],
            imageGradient: [GradientStop(r: 0.25, g: 0.0, b: 0.0), GradientStop(r: 0.45, g: 0.1, b: 0.05)],
            imageURL: URL(string: "https://images.pokemontcg.io/sv3/197_hires.png"),
            confidenceScore: 90
        ),
        MarketCard(
            id: "crown-zenith-gg70-mewtwo-vstar",
            name: "Mewtwo VSTAR",
            setName: "Crown Zenith",
            cardNumber: "#GG70",
            price: 38.50,
            changePct: 3.1,
            changeWindow: "24H",
            rarity: .ultraRare,
            sparkline: [35, 36, 37, 36.5, 37, 38, 38.5],
            imageGradient: [GradientStop(r: 0.15, g: 0.0, b: 0.25), GradientStop(r: 0.3, g: 0.05, b: 0.45)],
            imageURL: URL(string: "https://images.pokemontcg.io/swsh12pt5gg/GG44_hires.png"),
            confidenceScore: 72
        ),
        MarketCard(
            id: "paldea-evolved-193-ting-lu-ex",
            name: "Ting-Lu ex",
            setName: "Paldea Evolved",
            cardNumber: "#193",
            price: 22.75,
            changePct: -4.5,
            changeWindow: "24H",
            rarity: .rare,
            sparkline: [25, 24, 24.5, 23.5, 23, 22.5, 22.75],
            imageGradient: [GradientStop(r: 0.15, g: 0.1, b: 0.0), GradientStop(r: 0.3, g: 0.2, b: 0.05)],
            imageURL: URL(string: "https://images.pokemontcg.io/sv2/193_hires.png"),
            confidenceScore: 61
        ),
    ]

    static let topMovers: [MarketCard] = Array(trendingCards.sorted { $0.changePct > $1.changePct }.prefix(4))

    static let highValue: [MarketCard] = Array(trendingCards.sorted { $0.price > $1.price }.prefix(4))
}
