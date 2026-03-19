import Foundation

struct LabelMappingResult {
    let card: PopAlphaCard
    let debugIndexLabel: String?
}

final class LabelMapper {
    private static let targetCardIDs = [
        "prismatic-evolutions-161-umbreon-ex",
        "151-199-charizard-ex",
        "evolving-skies-215-rayquaza-vmax",
        "surging-sparks-128-pikachu-ex",
        "team-up-161-magikarp-wailord-gx"
    ]

    private let cardCatalog: PopAlphaCardCatalog
    private let targetCards: [PopAlphaCard]
    private var nextTargetCardIndex = 0

    init(cardCatalog: PopAlphaCardCatalog) {
        self.cardCatalog = cardCatalog
        self.targetCards = Self.resolveTargetCards(from: cardCatalog)
    }

    func mapModelOutput(_ label: String) -> LabelMappingResult {
        let normalizedLabel = normalized(label)

        if let exactMatch = exactMatch(for: normalizedLabel) {
            return LabelMappingResult(card: exactMatch, debugIndexLabel: nil)
        }

        if normalizedLabel == "pokemon_card",
           let mappedCard = nextTargetCard() {
            return mappedCard
        }

        return LabelMappingResult(
            card: cardCatalog.resolveCard(for: label),
            debugIndexLabel: nil
        )
    }

    private func exactMatch(for normalizedLabel: String) -> PopAlphaCard? {
        cardCatalog.cards.first { card in
            normalized(card.id) == normalizedLabel || normalized(card.name) == normalizedLabel
        }
    }

    private func nextTargetCard() -> LabelMappingResult? {
        guard !targetCards.isEmpty else {
            guard let randomCard = cardCatalog.randomCard() else {
                return nil
            }

            return LabelMappingResult(card: randomCard, debugIndexLabel: nil)
        }

        let displayIndex = nextTargetCardIndex + 1
        let card = targetCards[nextTargetCardIndex]
        nextTargetCardIndex = (nextTargetCardIndex + 1) % targetCards.count
        return LabelMappingResult(
            card: card,
            debugIndexLabel: "T-\(displayIndex)/\(targetCards.count)"
        )
    }

    private static func resolveTargetCards(from cardCatalog: PopAlphaCardCatalog) -> [PopAlphaCard] {
        let cardsByID = Dictionary(uniqueKeysWithValues: cardCatalog.cards.map { ($0.id, $0) })
        let resolvedTargetCards = targetCardIDs.compactMap { cardsByID[$0] }
        if resolvedTargetCards.count == targetCardIDs.count {
            return resolvedTargetCards
        }

        return Array(cardCatalog.cards.prefix(5))
    }

    private func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "_")
            .replacingOccurrences(of: "-", with: "_")
    }
}
