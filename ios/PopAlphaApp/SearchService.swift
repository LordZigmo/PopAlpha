import Foundation

// MARK: - Search Service — Calls PopAlpha search API (no auth required)

actor SearchService {
    static let shared = SearchService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Autocomplete search — returns up to 100 ranked results
    /// Calls GET /api/search/cards?q=<query>
    func search(query: String) async throws -> [SearchCardResult] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        let response: SearchResponse = try await APIClient.get(
            path: "/api/search/cards",
            query: [("q", trimmed)],
            decoder: decoder
        )

        guard response.ok else { return [] }
        return response.cards
    }
}
