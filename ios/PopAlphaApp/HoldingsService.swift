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

    // MARK: - Bulk add (multi-scan)

    /// Submits a multi-scan tray to /api/holdings/bulk-import with
    /// `source: "scanner"` so holdings.source distinguishes scan-
    /// derived lots from CSV-imported and manually-added ones. The
    /// endpoint is per-row best-effort: bad rows surface in `errors[]`
    /// without blocking the rest. `'scanner'` is already an allowed
    /// value in the holdings_source_check constraint
    /// (supabase/migrations/20260421200152_holdings_source.sql) — no
    /// new migration needed.
    ///
    /// Chunked at `Self.bulkImportChunkSize` (= the route's MAX_ROWS
    /// cap of 500) so a long binder session can't blow past the
    /// server's hard cap. Row indices in returned errors are mapped
    /// back to the caller's tray-absolute index — the caller's tray
    /// rendering doesn't need to know chunks happened.
    func bulkAddFromScans(_ entries: [MultiScanEntry]) async throws -> BulkScanImportSummary {
        try AuthService.shared.requireAuth()

        var totalInserted = 0
        var allErrors: [BulkScanImportError] = []
        var cursor = 0

        while cursor < entries.count {
            let chunkEnd = min(cursor + Self.bulkImportChunkSize, entries.count)
            let chunk = entries[cursor..<chunkEnd]
            let offsetBase = cursor

            let rows: [[String: Any]] = chunk.map { entry in
                var row: [String: Any] = [
                    "canonical_slug": entry.match.slug,
                    "grade": entry.grade,
                    "qty": entry.quantity,
                ]
                if let printingId = entry.printingId {
                    row["printing_id"] = printingId
                }
                return row
            }

            let body: [String: Any] = [
                "rows": rows,
                "source": "scanner",
            ]

            let response: BulkScanImportResponse = try await APIClient.post(
                path: "/api/holdings/bulk-import",
                body: body,
                decoder: decoder,
            )

            totalInserted += response.inserted
            // Re-index chunk-relative row_index back to tray-absolute
            // so the caller can correlate per-row errors with the
            // original MultiScanEntry array offsets.
            for e in response.errors {
                allErrors.append(
                    BulkScanImportError(
                        rowIndex: e.rowIndex + offsetBase,
                        message: e.error,
                    ),
                )
            }

            cursor = chunkEnd
        }

        return BulkScanImportSummary(
            inserted: totalInserted,
            errors: allErrors,
        )
    }

    /// Match the route's hard cap (`MAX_ROWS = 500` in
    /// `app/api/holdings/bulk-import/route.ts`). Any tray larger than
    /// this is split into multiple POSTs; smaller trays do a single
    /// round-trip.
    private static let bulkImportChunkSize: Int = 500

    // MARK: - Delete

    /// Remove one or more holding lots by ID. Typically all lots in a
    /// position are passed together so the entire card disappears from
    /// the portfolio in one request.
    func deleteHoldings(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        try AuthService.shared.requireAuth()

        let idsParam = ids.joined(separator: ",")
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
        id: String,
        grade: String,
        qty: Int,
        pricePaidUsd: Double?,
        acquiredOn: String?,
        venue: String?,
        certNumber: String?
    ) async throws {
        try AuthService.shared.requireAuth()

        // Always send all editable fields. NSNull() for nil so the
        // server distinguishes "explicit clear" from "omitted" —
        // PATCH treats `"field" in body` as the update signal.
        //
        // Built field-by-field rather than in a literal because the
        // `optionalDouble as Any? ?? NSNull()` idiom can wrap into a
        // double-optional that JSONSerialization rejects with an
        // "invalid type in JSON write" exception.
        var body: [String: Any] = [
            "id": id,
            "grade": grade,
            "qty": qty,
        ]
        body["price_paid_usd"] = pricePaidUsd.map { $0 as Any } ?? NSNull()
        body["acquired_on"]    = (acquiredOn.flatMap  { $0.isEmpty ? nil : ($0 as Any) }) ?? NSNull()
        body["venue"]          = (venue.flatMap       { $0.isEmpty ? nil : ($0 as Any) }) ?? NSNull()
        body["cert_number"]    = (certNumber.flatMap  { $0.isEmpty ? nil : ($0 as Any) }) ?? NSNull()

        let _: SimpleOKResponse = try await APIClient.patch(
            path: "/api/holdings",
            body: body,
            decoder: decoder
        )
    }
}

// MARK: - Bulk import decoding

/// Mirror of /api/holdings/bulk-import's response shape. 200 with
/// `ok: true` on happy path; 400 with `ok: false` + `error` when ALL
/// rows are rejected. Per-row errors flow through `errors[]` regardless
/// of HTTP status — the route's contract is "individual rows can fail
/// without poisoning the batch."
private struct BulkScanImportResponse: Decodable {
    let ok: Bool
    let inserted: Int
    let errors: [RowError]
    let error: String?

    // Auto-synthesized CodingKeys (i.e., the property names verbatim)
    // pair correctly with HoldingsService's `.convertFromSnakeCase`
    // decoder — the strategy already maps JSON `row_index` → Swift
    // `rowIndex` at decode time. A custom CodingKeys block with
    // `case rowIndex = "row_index"` would double-map and throw
    // keyNotFound when the strategy reaches the now-converted key
    // (Codex P2 review caught this on the initial implementation —
    // a partial-success response would silently fail to decode, the
    // batch would look like a full HTTP failure, and a retry could
    // duplicate the already-inserted rows).
    struct RowError: Decodable {
        let rowIndex: Int
        let error: String
    }
}
