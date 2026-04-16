import SwiftUI

// MARK: - Time Window

enum TimeWindow: String, CaseIterable, Identifiable {
    case day = "1D"
    case week = "7D"
    case month = "30D"

    var id: String { rawValue }
}

// MARK: - Collector Type

enum CollectorType: String, CaseIterable, Identifiable {
    case grailHunter = "Grail Hunter"
    case setFinisher = "Set Finisher"
    case nostalgiaCurator = "Nostalgia Curator"
    case modernMomentum = "Modern Momentum"
    case trophyCollector = "Trophy Collector"
    case marketOpportunist = "Market Opportunist"
    case completionist = "Completionist"
    case gradedPurist = "Graded Purist"
    case binderBuilder = "Binder Builder"
    case sealedStrategist = "Sealed Strategist"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .grailHunter: "diamond"
        case .setFinisher: "checkmark.seal"
        case .nostalgiaCurator: "clock.arrow.circlepath"
        case .modernMomentum: "bolt.fill"
        case .trophyCollector: "trophy"
        case .marketOpportunist: "chart.line.uptrend.xyaxis"
        case .completionist: "square.grid.3x3.fill"
        case .gradedPurist: "star.fill"
        case .binderBuilder: "book.closed"
        case .sealedStrategist: "lock.shield"
        }
    }
}

// MARK: - Portfolio Summary

struct PortfolioSummary {
    let totalValue: Double
    let changes: [TimeWindow: PortfolioChange]
    let cardCount: Int
    let rawCount: Int
    let gradedCount: Int
    let sealedCount: Int
    let sparkline: [Double]
    let aiSummary: String

    func change(for window: TimeWindow) -> PortfolioChange {
        changes[window] ?? PortfolioChange(amount: 0, percent: 0)
    }
}

struct PortfolioChange {
    let amount: Double
    let percent: Double
    var isPositive: Bool { percent >= 0 }
}

// MARK: - Collector Identity

struct CollectorIdentityProfile {
    let primaryType: CollectorType
    let confidence: Double
    let explanation: String
    let traits: [CollectorTrait]
}

struct CollectorTrait: Identifiable {
    var id: String { type.rawValue }
    let type: CollectorType
    let strength: Double
}

// MARK: - Portfolio Composition

struct PortfolioComposition {
    let byEra: [AllocationSegment]
    let byCategory: [AllocationSegment]
}

struct AllocationSegment: Identifiable {
    var id: String { label }
    let label: String
    let value: Double
    let color: Color
}

// MARK: - Portfolio Attribute

struct PortfolioAttribute: Identifiable {
    var id: String { title }
    let title: String
    let subtitle: String
    let icon: String
}

// MARK: - Top Holding (display model for the top-N view)

struct TopHolding: Identifiable {
    var id: String { "\(name)-\(variant)" }
    let name: String
    let setName: String
    let variant: String
    let currentValue: Double
    let changePct: Double
    let descriptor: String?
    let accentColor: Color
}

// MARK: - Insight

struct PortfolioInsight: Identifiable {
    var id: String { text }
    let text: String
}

// MARK: - Activity

struct PortfolioActivity: Identifiable {
    var id: String { title }
    let title: String
    let description: String
    let timeAgo: String
    let icon: String
}

// MARK: - Portfolio Attributes (input for CollectorIdentityEngine)

struct PortfolioAttributes {
    let vintagePercent: Double
    let gradedPercent: Double
    let sealedPercent: Double
    let topHoldingConcentration: Double
    let setBreadth: Double
    let nostalgiaScore: Double
    let modernPercent: Double
    let grailDensity: Double
    let trophyDensity: Double
    let avgGrade: Double
    let setCompletionRate: Double
}

// MARK: - Mock Data
// Future: replace with API-driven data from /api/portfolio/summary, /api/portfolio/identity, etc.

enum PortfolioMockData {

    static let summary = PortfolioSummary(
        totalValue: 14_280,
        changes: [
            .day:   PortfolioChange(amount: 142,  percent: 1.0),
            .week:  PortfolioChange(amount: 680,  percent: 5.0),
            .month: PortfolioChange(amount: 1820, percent: 14.6),
        ],
        cardCount: 47,
        rawCount: 28,
        gradedCount: 14,
        sealedCount: 5,
        sparkline: [
            12_200, 12_350, 12_100, 12_400, 12_650, 12_800, 13_100,
            13_400, 13_200, 13_600, 13_800, 14_000, 14_100, 14_280,
        ],
        aiSummary: "Your collection leans high-conviction, nostalgia-heavy, and surprisingly concentrated in late-WotC grails."
    )

    static let composition = PortfolioComposition(
        byEra: [
            AllocationSegment(label: "WotC (Base–Neo)",  value: 0.42, color: Color(red: 1.0, green: 0.843, blue: 0.0)),
            AllocationSegment(label: "EX Series",        value: 0.18, color: Color(red: 0.0, green: 0.706, blue: 0.847)),
            AllocationSegment(label: "Diamond & Pearl",  value: 0.08, color: Color(red: 0.6, green: 0.4,   blue: 0.85)),
            AllocationSegment(label: "Modern (S&V)",     value: 0.22, color: Color(red: 0.0, green: 0.863, blue: 0.353)),
            AllocationSegment(label: "Other",            value: 0.10, color: Color(red: 0.42, green: 0.42, blue: 0.42)),
        ],
        byCategory: [
            AllocationSegment(label: "Raw",    value: 0.55, color: Color(red: 0.58, green: 0.58, blue: 0.58)),
            AllocationSegment(label: "Graded", value: 0.35, color: Color(red: 0.0,  green: 0.706, blue: 0.847)),
            AllocationSegment(label: "Sealed", value: 0.10, color: Color(red: 1.0,  green: 0.843, blue: 0.0)),
        ]
    )

    static let attributes: [PortfolioAttribute] = [
        PortfolioAttribute(title: "High Nostalgia",           subtitle: "62% in pre-2003 sets",            icon: "clock.arrow.circlepath"),
        PortfolioAttribute(title: "Charizard Concentrated",   subtitle: "3 Charizard cards, 68% of value", icon: "flame"),
        PortfolioAttribute(title: "PSA 10 Bias",              subtitle: "4 gem mint slabs",                icon: "star.fill"),
        PortfolioAttribute(title: "Vintage First",            subtitle: "WotC-era dominated",              icon: "clock"),
        PortfolioAttribute(title: "Low Diversification",      subtitle: "Top 3 = 82% of value",            icon: "chart.pie"),
        PortfolioAttribute(title: "Grail Dense",              subtitle: "6 cards over $500",               icon: "diamond"),
    ]

    static let topHoldings: [TopHolding] = [
        TopHolding(name: "Charizard",         setName: "Base Set 1st Edition", variant: "PSA 9",  currentValue: 8200, changePct:  12.3, descriptor: "Largest holding", accentColor: Color(red: 1.0,  green: 0.4,  blue: 0.2)),
        TopHolding(name: "Blastoise",         setName: "Base Set Shadowless",  variant: "PSA 10", currentValue: 2400, changePct:   8.1, descriptor: "Best performer",  accentColor: Color(red: 0.2,  green: 0.5,  blue: 0.9)),
        TopHolding(name: "Lugia",             setName: "Neo Genesis 1st Ed",   variant: "PSA 9",  currentValue: 1200, changePct:   4.2, descriptor: nil,               accentColor: Color(red: 0.7,  green: 0.7,  blue: 0.9)),
        TopHolding(name: "Umbreon",           setName: "Gold Star",            variant: "RAW",    currentValue:  850, changePct:  -2.1, descriptor: nil,               accentColor: Color(red: 0.1,  green: 0.1,  blue: 0.4)),
        TopHolding(name: "Shining Charizard", setName: "Neo Destiny",          variant: "PSA 8",  currentValue:  620, changePct:  15.4, descriptor: "Fastest gainer",  accentColor: Color(red: 0.9,  green: 0.3,  blue: 0.1)),
    ]

    static let insights: [PortfolioInsight] = [
        PortfolioInsight(text: "Your portfolio is more curator-driven than investor-driven."),
        PortfolioInsight(text: "Your gains are being driven by a small number of high-conviction cards."),
        PortfolioInsight(text: "You prefer iconic scarcity over set breadth."),
    ]

    static let activities: [PortfolioActivity] = [
        PortfolioActivity(title: "Shifting toward legacy quality", description: "You've been moving from modern speculation into legacy-grade quality over the last 90 days.", timeAgo: "Trend",      icon: "arrow.up.right"),
        PortfolioActivity(title: "Added Shining Charizard",       description: "Neo Destiny PSA 8 — deepened your vintage Charizard position.",                           timeAgo: "2 days ago", icon: "plus.circle"),
        PortfolioActivity(title: "Upgraded Blastoise",            description: "Moved from PSA 9 to PSA 10 — strong conviction play.",                                    timeAgo: "1 week ago", icon: "arrow.up.circle"),
    ]

    static let attributesInput = PortfolioAttributes(
        vintagePercent: 0.62,
        gradedPercent: 0.35,
        sealedPercent: 0.10,
        topHoldingConcentration: 0.82,
        setBreadth: 0.25,
        nostalgiaScore: 0.78,
        modernPercent: 0.22,
        grailDensity: 0.42,
        trophyDensity: 0.18,
        avgGrade: 9.1,
        setCompletionRate: 0.15
    )
}
