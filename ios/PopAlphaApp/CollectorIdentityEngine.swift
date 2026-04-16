import Foundation

// MARK: - Collector Identity Engine
//
// Lightweight prototype scoring system that infers a collector's primary type
// and secondary traits from portfolio attributes. Each collector type is scored
// 0–1 using a weighted combination of portfolio signals. The highest-scoring
// type becomes the primary identity; the next 2–3 become secondary traits.
//
// Future: move this to the backend for richer signal processing (price history,
// acquisition velocity, market timing patterns, etc.).

enum CollectorIdentityEngine {

    // MARK: - Public API

    static func analyze(_ attrs: PortfolioAttributes) -> CollectorIdentityProfile {
        let scores = CollectorType.allCases
            .map { type in (type, score(for: type, attrs: attrs)) }
            .sorted { $0.1 > $1.1 }

        let primary = scores[0]
        let secondaryTraits = scores.dropFirst().prefix(3).map {
            CollectorTrait(type: $0.0, strength: $0.1)
        }

        return CollectorIdentityProfile(
            primaryType: primary.0,
            confidence: primary.1,
            explanation: explanation(for: primary.0, attrs: attrs),
            traits: Array(secondaryTraits)
        )
    }

    // MARK: - Per-Type Scoring

    private static func score(for type: CollectorType, attrs: PortfolioAttributes) -> Double {
        switch type {
        case .grailHunter:
            return weighted([
                (attrs.grailDensity,             0.35),
                (attrs.topHoldingConcentration,   0.25),
                (attrs.vintagePercent,            0.15),
                (1 - attrs.setBreadth,            0.15),
                (attrs.trophyDensity,             0.10),
            ])

        case .setFinisher:
            return weighted([
                (attrs.setCompletionRate,         0.40),
                (attrs.setBreadth,                0.30),
                (1 - attrs.topHoldingConcentration, 0.15),
                (1 - attrs.grailDensity,          0.15),
            ])

        case .nostalgiaCurator:
            return weighted([
                (attrs.nostalgiaScore,            0.35),
                (attrs.vintagePercent,            0.30),
                (1 - attrs.modernPercent,         0.15),
                (attrs.grailDensity,              0.10),
                (attrs.topHoldingConcentration,   0.10),
            ])

        case .modernMomentum:
            return weighted([
                (attrs.modernPercent,             0.40),
                (1 - attrs.vintagePercent,        0.25),
                (1 - attrs.nostalgiaScore,        0.20),
                (attrs.setBreadth,                0.15),
            ])

        case .trophyCollector:
            return weighted([
                (attrs.trophyDensity,             0.35),
                (attrs.grailDensity,              0.25),
                (attrs.topHoldingConcentration,   0.20),
                (attrs.gradedPercent,             0.10),
                (min(attrs.avgGrade / 10.0, 1.0), 0.10),
            ])

        case .marketOpportunist:
            return weighted([
                (attrs.modernPercent,             0.25),
                (attrs.setBreadth,                0.25),
                (1 - attrs.nostalgiaScore,        0.20),
                (1 - attrs.topHoldingConcentration, 0.15),
                (1 - attrs.vintagePercent,        0.15),
            ])

        case .completionist:
            return weighted([
                (attrs.setBreadth,                0.35),
                (attrs.setCompletionRate,         0.30),
                (1 - attrs.topHoldingConcentration, 0.20),
                (1 - attrs.grailDensity,          0.15),
            ])

        case .gradedPurist:
            return weighted([
                (attrs.gradedPercent,             0.40),
                (min(attrs.avgGrade / 10.0, 1.0), 0.30),
                (attrs.grailDensity,              0.15),
                (attrs.topHoldingConcentration,   0.15),
            ])

        case .binderBuilder:
            return weighted([
                (1 - attrs.gradedPercent,         0.30),
                (1 - attrs.sealedPercent,         0.20),
                (attrs.setBreadth,                0.25),
                (1 - attrs.topHoldingConcentration, 0.15),
                (1 - attrs.grailDensity,          0.10),
            ])

        case .sealedStrategist:
            return weighted([
                (attrs.sealedPercent,             0.50),
                (1 - attrs.gradedPercent,         0.20),
                (attrs.modernPercent,             0.15),
                (1 - attrs.vintagePercent,        0.15),
            ])
        }
    }

    private static func weighted(_ pairs: [(value: Double, weight: Double)]) -> Double {
        pairs.reduce(0) { $0 + $1.value * $1.weight }
    }

    // MARK: - Explanations

    private static func explanation(for type: CollectorType, attrs: PortfolioAttributes) -> String {
        switch type {
        case .grailHunter:
            return "Your portfolio centers on high-value chase cards. You prefer conviction over diversification, targeting the cards other collectors dream about."
        case .setFinisher:
            return "You approach collecting with completionist discipline. Your portfolio shows methodical progress toward filling out the sets you care about."
        case .nostalgiaCurator:
            return "You favor iconic legacy cards with emotional and historical weight over broad diversification. Your portfolio suggests deliberate taste rather than pure speculation."
        case .modernMomentum:
            return "You stay close to the current meta, building positions in new releases and emerging chase cards before the wider market catches on."
        case .trophyCollector:
            return "Your collection reads like a highlight reel. You invest in statement pieces — the cards that define collections and turn heads."
        case .marketOpportunist:
            return "You collect with a trader\u{2019}s eye, spotting undervalued opportunities across eras and categories. Your portfolio is built on market awareness."
        case .completionist:
            return "You cast a wide net, building broad coverage across sets and eras. Your collection values breadth and the joy of discovery."
        case .gradedPurist:
            return "Condition is everything to you. Your portfolio skews heavily toward professionally graded cards, with a clear preference for top grades."
        case .binderBuilder:
            return "You collect for the tangible experience. Your portfolio is raw-heavy, focused on building a physical collection you can hold and enjoy."
        case .sealedStrategist:
            return "You treat sealed product as a long-term asset. Your allocation toward unopened product suggests patience and a belief in future demand."
        }
    }
}
