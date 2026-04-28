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

    /// Map snake_case API values to enum cases.
    init?(apiValue: String) {
        switch apiValue {
        case "grail_hunter": self = .grailHunter
        case "set_finisher": self = .setFinisher
        case "nostalgia_curator": self = .nostalgiaCurator
        case "modern_momentum": self = .modernMomentum
        case "trophy_collector": self = .trophyCollector
        case "market_opportunist": self = .marketOpportunist
        case "completionist": self = .completionist
        case "graded_purist": self = .gradedPurist
        case "binder_builder": self = .binderBuilder
        case "sealed_strategist": self = .sealedStrategist
        default: return nil
        }
    }

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

// MARK: - View-Layer Models (used by SwiftUI components)

struct PortfolioSummary {
    let totalValue: Double
    let totalCostBasis: Double
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

struct PortfolioAttribute: Identifiable {
    var id: String { title }
    let title: String
    let subtitle: String
    let icon: String
}

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

struct PortfolioInsight: Identifiable {
    var id: String { text }
    let text: String
}

struct PortfolioActivity: Identifiable {
    var id: String { title }
    let title: String
    let description: String
    let timeAgo: String
    let icon: String
}

// MARK: - API Response Decodable Types

struct APIRadarProfile: Decodable {
    let vintage: Double
    let graded: Double
    let premium: Double
    let setFinisher: Double
    let japanese: Double
    let grailHunter: Double
}

/// Top-level response from GET /api/portfolio/overview
struct PortfolioOverviewResponse: Decodable {
    let ok: Bool
    let minimal: Bool?
    let summary: APISummary?
    let sparkline: [Double]?
    let cardMetadata: [String: APICardMetadata]?
    let identity: APIIdentity?
    let composition: APIComposition?
    let topHoldings: [APITopHolding]?
    let attributes: [APIAttribute]?
    let insights: [String]?
    let radarProfile: APIRadarProfile?
}

struct APICardMetadata: Decodable {
    let name: String
    let setName: String?
    let imageUrl: String?
    let marketPrice: Double?
    let changePct: Double?
}

struct APISummary: Decodable {
    let totalValue: Double
    let totalCostBasis: Double
    let pnlAmount: Double
    let pnlPct: Double?
    let cardCount: Int
    let rawCount: Int
    let gradedCount: Int
}

struct APIIdentity: Decodable {
    let primaryType: String
    let confidence: Double
    let explanation: String
    let traits: [APITrait]
}

struct APITrait: Decodable {
    let type: String
    let strength: Double
}

struct APIComposition: Decodable {
    let byEra: [APISegment]
    let byCategory: [APISegment]
}

struct APISegment: Decodable {
    let label: String
    let value: Double
}

struct APITopHolding: Decodable {
    let name: String
    let setName: String
    let variant: String
    let currentValue: Double
    let changePct: Double
    let descriptor: String?
    let imageUrl: String?
}

struct APIAttribute: Decodable {
    let title: String
    let subtitle: String
    let icon: String
}

/// Top-level response from GET /api/portfolio/activity
struct PortfolioActivityResponse: Decodable {
    let ok: Bool
    let activities: [APIActivity]?
}

struct APIActivity: Decodable {
    let title: String
    let description: String
    let timeAgo: String
    let icon: String
}

// MARK: - API → View Model Conversion

extension PortfolioOverviewResponse {

    func toSummary() -> PortfolioSummary? {
        guard let s = summary else { return nil }
        let pnl = PortfolioChange(amount: s.pnlAmount, percent: s.pnlPct ?? 0)
        return PortfolioSummary(
            totalValue: s.totalValue,
            totalCostBasis: s.totalCostBasis,
            changes: [.day: pnl],
            cardCount: s.cardCount,
            rawCount: s.rawCount,
            gradedCount: s.gradedCount,
            sealedCount: 0,
            sparkline: sparkline ?? [],
            aiSummary: ""
        )
    }

    func toIdentity() -> CollectorIdentityProfile? {
        guard let id = identity else { return nil }
        guard let primary = CollectorType(apiValue: id.primaryType) else { return nil }
        let traits = id.traits.compactMap { t -> CollectorTrait? in
            guard let type = CollectorType(apiValue: t.type) else { return nil }
            return CollectorTrait(type: type, strength: t.strength)
        }
        return CollectorIdentityProfile(
            primaryType: primary,
            confidence: id.confidence,
            explanation: id.explanation,
            traits: traits
        )
    }

    func toComposition() -> PortfolioComposition? {
        guard let c = composition else { return nil }
        let eraColors: [String: Color] = [
            "WotC (Base–Neo)": Color(red: 1.0, green: 0.843, blue: 0.0),
            "EX Series": Color(red: 0.0, green: 0.706, blue: 0.847),
            "Diamond & Pearl": Color(red: 0.6, green: 0.4, blue: 0.85),
            "BW / XY": Color(red: 0.55, green: 0.75, blue: 0.35),
            "Modern": Color(red: 0.0, green: 0.863, blue: 0.353),
        ]
        let categoryColors: [String: Color] = [
            "Raw": Color(red: 0.58, green: 0.58, blue: 0.58),
            "Graded": Color(red: 0.0, green: 0.706, blue: 0.847),
            "Sealed": Color(red: 1.0, green: 0.843, blue: 0.0),
        ]
        return PortfolioComposition(
            byEra: c.byEra.map { s in
                AllocationSegment(label: s.label, value: s.value, color: eraColors[s.label] ?? PA.Colors.muted)
            },
            byCategory: c.byCategory.map { s in
                AllocationSegment(label: s.label, value: s.value, color: categoryColors[s.label] ?? PA.Colors.muted)
            }
        )
    }

    func toTopHoldings() -> [TopHolding] {
        (topHoldings ?? []).map { h in
            TopHolding(
                name: h.name,
                setName: h.setName,
                variant: h.variant,
                currentValue: h.currentValue,
                changePct: h.changePct,
                descriptor: h.descriptor,
                accentColor: h.changePct >= 0 ? PA.Colors.positive.opacity(0.7) : PA.Colors.negative.opacity(0.7)
            )
        }
    }

    func toAttributes() -> [PortfolioAttribute] {
        (attributes ?? []).map { a in
            PortfolioAttribute(title: a.title, subtitle: a.subtitle, icon: a.icon)
        }
    }

    func toInsights() -> [PortfolioInsight] {
        (insights ?? []).map { PortfolioInsight(text: $0) }
    }
}

extension PortfolioActivityResponse {
    func toActivities() -> [PortfolioActivity] {
        (activities ?? []).map { a in
            PortfolioActivity(title: a.title, description: a.description, timeAgo: a.timeAgo, icon: a.icon)
        }
    }
}
