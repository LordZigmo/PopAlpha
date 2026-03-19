import Foundation

public struct PopAlphaCard: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let setName: String?
    public let price: Double?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case setName = "set"
        case price
    }

    public init(
        id: String,
        name: String,
        setName: String?,
        price: Double?
    ) {
        self.id = id
        self.name = name
        self.setName = setName
        self.price = price
    }
}

enum PopAlphaCardCatalogError: LocalizedError {
    case missingMockCardsResource
    case failedToDecodeMockCards
    case emptyMockCards

    var errorDescription: String? {
        switch self {
        case .missingMockCardsResource:
            return "Unable to find mock_cards.json in the scanner bundle."
        case .failedToDecodeMockCards:
            return "Unable to decode mock_cards.json using the shared card schema."
        case .emptyMockCards:
            return "mock_cards.json does not contain any cards."
        }
    }
}

struct PopAlphaCardCatalog {
    let cards: [PopAlphaCard]

    init(bundle: Bundle) throws {
        guard let url = bundle.url(forResource: "mock_cards", withExtension: "json") else {
            throw PopAlphaCardCatalogError.missingMockCardsResource
        }

        let data = try Data(contentsOf: url)

        do {
            self.cards = try JSONDecoder().decode([PopAlphaCard].self, from: data)
        } catch {
            throw PopAlphaCardCatalogError.failedToDecodeMockCards
        }

        guard !cards.isEmpty else {
            throw PopAlphaCardCatalogError.emptyMockCards
        }
    }

    func randomCard() -> PopAlphaCard? {
        cards.randomElement()
    }

    func resolveCard(for id: String) -> PopAlphaCard {
        cards.first(where: { $0.id == id })
            ?? PopAlphaCard(id: id, name: id, setName: nil, price: nil)
    }
}
