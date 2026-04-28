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

    // MARK: - Delete

    /// Remove one or more holding lots by ID. Typically all lots in a
    /// position are passed together so the entire card disappears from
    /// the portfolio in one request.
    func deleteHoldings(ids: [Int]) async throws {
        guard !ids.isEmpty else { return }
        try AuthService.shared.requireAuth()

        let idsParam = ids.map(String.init).joined(separator: ",")
        let _: SimpleOKResponse = try await APIClient.delete(
            path: "/api/holdings",
            query: [("ids", idsParam)],
            decoder: decoder
        )
    }

    // MARK: - Update

    /// Full replace of the user-editable fields on a single holding.
    /// The edit-sheet UX hands the user current values for every field;
    /// submitting replays all of them to the server. Nil/empty on the
    /// nullable fields means "clear on the server" (stores NULL).
    ///
    /// Use this when the caller has all current values in hand. For a
    /// surgical single-field update, build the PATCH body directly.
    func updateHolding(
        id: Int,
        grade: String,
        qty: Int,
        pricePaidUsd: Double?,
        acquiredOn: String?,
        venue: String?,
        certNumber: String?
    ) async throws {
        try AuthService.shared.requireAuth()

        // Always send all editable fields. NSNull() for Swift nil so
        // the server distinguishes "explicit clear" from "omitted" —
        // PATCH treats `"field" in body` as the update signal.
        var body: [String: Any] = [
            "id": id,
            "grade": grade,
            "qty": qty,
            "price_paid_usd": pricePaidUsd as Any? ?? NSNull(),
            "acquired_on": (acquiredOn?.isEmpty == false ? acquiredOn! : NSNull()) as Any,
            "venue": (venue?.isEmpty == false ? venue! : NSNull()) as Any,
            "cert_number": (certNumber?.isEmpty == false ? certNumber! : NSNull()) as Any,
        ]
        // `pricePaidUsd as Any? ?? NSNull()` evaluates a double-optional,
        // so collapse it to a concrete value here for JSONSerialization.
        if pricePaidUsd == nil { body["price_paid_usd"] = NSNull() }

        let _: SimpleOKResponse = try await APIClient.patch(
            path: "/api/holdings",
            body: body,
            decoder: decoder
        )
    }
}
