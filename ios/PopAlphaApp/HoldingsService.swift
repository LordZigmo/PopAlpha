import Foundation

// MARK: - Holdings Service — Portfolio management via PopAlpha API

actor HoldingsService {
    static let shared = HoldingsService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: - Fetch

    /// List all holdings for the authenticated user
    func fetchHoldings() async throws -> [HoldingRow] {
        try AuthService.shared.requireAuth()

        let response: HoldingsResponse = try await APIClient.get(
            path: "/api/holdings",
            decoder: decoder
        )
        guard response.ok else { return [] }
        return response.holdings
    }

    // MARK: - Add

    /// Add a new lot to the portfolio.
    /// `pricePaidUsd` is optional — omit for holdings whose cost basis
    /// the user doesn't remember. Server stores NULL in that case.
    func addHolding(
        canonicalSlug: String,
        grade: String,
        qty: Int,
        pricePaidUsd: Double? = nil,
        acquiredOn: String? = nil,
        venue: String? = nil,
        certNumber: String? = nil
    ) async throws {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = [
            "canonical_slug": canonicalSlug,
            "grade": grade,
            "qty": qty,
        ]
        if let pricePaidUsd { body["price_paid_usd"] = pricePaidUsd }
        if let acquiredOn { body["acquired_on"] = acquiredOn }
        if let venue { body["venue"] = venue }
        if let certNumber { body["cert_number"] = certNumber }

        let _: SimpleOKResponse = try await APIClient.post(
            path: "/api/holdings",
            body: body,
            decoder: decoder
        )
    }

    // MARK: - Update

    /// Update an existing holding (partial update)
    func updateHolding(
        id: Int,
        grade: String? = nil,
        qty: Int? = nil,
        pricePaidUsd: Double? = nil,
        acquiredOn: String? = nil,
        venue: String? = nil,
        certNumber: String? = nil
    ) async throws {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = ["id": id]
        if let grade { body["grade"] = grade }
        if let qty { body["qty"] = qty }
        if let pricePaidUsd { body["price_paid_usd"] = pricePaidUsd }
        if let acquiredOn { body["acquired_on"] = acquiredOn }
        if let venue { body["venue"] = venue }
        if let certNumber { body["cert_number"] = certNumber }

        let _: SimpleOKResponse = try await APIClient.patch(
            path: "/api/holdings",
            body: body,
            decoder: decoder
        )
    }
}
