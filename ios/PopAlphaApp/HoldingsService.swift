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
        certNumber: String? = nil,
        printingId: String? = nil
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
        // nil printingId → server stores NULL → portfolio prices off the
        // canonical preferred printing (today's behavior). A non-nil value
        // pins the lot to the specific finish the user picked.
        if let printingId { body["printing_id"] = printingId }

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
    ///
    /// Partial-failure semantics (Codex P2 review on PR #83, seventh
    /// pass): when a mid-batch chunk throws after earlier chunks
    /// already inserted server-side, we DON'T rethrow — that would
    /// strand the partial progress and the caller would resubmit the
    /// already-inserted rows on retry, creating duplicate holdings.
    /// Instead we synthesize errors for the failed chunk + every
    /// remaining unattempted row, returning the accumulated
    /// `inserted` count alongside. The caller (MultiScanSession.submit)
    /// prunes by error-set membership, so the already-inserted rows
    /// drop out of the tray and only the actually-pending rows
    /// remain for retry. We only rethrow when the FIRST chunk fails
    /// (no progress to preserve) so the caller's "Couldn't connect"
    /// HTTP-error path still fires for the simple offline case.
    func bulkAddFromScans(_ entries: [MultiScanEntry]) async throws -> BulkScanImportSummary {
        try AuthService.shared.requireAuth()

        // Idempotency backstop: a thrown chunk is AMBIGUOUS — a timeout
        // or lost/undecodable response can arrive AFTER the server
        // committed the insert, and retrying such a chunk duplicates
        // holdings. Snapshot per-key lot counts up front; when a chunk
        // throws, re-fetch and compare deltas to decide whether it
        // landed (the route inserts each chunk atomically, so it's
        // all-or-nothing per chunk). nil snapshot (the GET itself
        // failed) disables the backstop and preserves the old
        // pessimistic behavior.
        let preImportCounts = (try? await fetchHoldings()).map(Self.lotCountsByKey)
        var confirmedInsertedCounts: [String: Int] = [:]

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
                    // Idempotency key: MultiScanEntry.id is stable across
                    // retries of the same tray, so the server (unique on
                    // owner + client_lot_id, ignore-duplicates upsert)
                    // recognizes a resubmitted row that already committed
                    // and no-ops instead of duplicating the lot. First
                    // line of defense; the delta backstop below remains
                    // for servers predating the column.
                    "client_lot_id": entry.id.uuidString.lowercased(),
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

            do {
                let response: BulkScanImportResponse = try await APIClient.post(
                    path: "/api/holdings/bulk-import",
                    body: body,
                    decoder: decoder,
                )

                totalInserted += response.inserted
                // Track which rows the server confirmed (chunk rows not
                // in errors[]) so the backstop's delta math can tell a
                // later ambiguous chunk apart from these.
                let failedRelativeIndices = Set(response.errors.map { $0.rowIndex })
                for (relativeIndex, entry) in chunk.enumerated() where !failedRelativeIndices.contains(relativeIndex) {
                    confirmedInsertedCounts[Self.lotKey(for: entry), default: 0] += 1
                }
                // Re-index chunk-relative row_index back to tray-
                // absolute so the caller can correlate per-row
                // errors with the original MultiScanEntry array.
                for e in response.errors {
                    allErrors.append(
                        BulkScanImportError(
                            rowIndex: e.rowIndex + offsetBase,
                            message: e.error,
                        ),
                    )
                }
            } catch {
                // Ambiguous failure: the request may or may not have
                // committed server-side. Ask the backstop before
                // assuming "not inserted".
                if let preImportCounts,
                   await failedChunkLanded(
                       chunk: chunk,
                       preCounts: preImportCounts,
                       confirmedCounts: confirmedInsertedCounts,
                   ) == true {
                    // Committed — only the response was lost. Count the
                    // chunk as inserted and keep going; retrying it
                    // would create duplicate holdings.
                    totalInserted += chunk.count
                    for entry in chunk {
                        confirmedInsertedCounts[Self.lotKey(for: entry), default: 0] += 1
                    }
                    cursor = chunkEnd
                    continue
                }
                // First-chunk failure with no progress yet — rethrow
                // so the caller surfaces a clear connection/auth
                // error and the tray stays fully intact for retry.
                if totalInserted == 0 && allErrors.isEmpty {
                    throw error
                }
                // Mid-batch failure with earlier chunks already
                // inserted server-side. Synthesize errors for the
                // failed chunk + all remaining unattempted rows so
                // the caller prunes only the actually-inserted rows
                // and keeps the rest in the tray for retry. Without
                // this, the caller would resubmit the already-
                // inserted rows on the next Add, creating dupes.
                let chunkErrorMessage = error.localizedDescription
                for i in cursor..<entries.count {
                    let isInFailedChunk = i < chunkEnd
                    allErrors.append(
                        BulkScanImportError(
                            rowIndex: i,
                            message: isInFailedChunk
                                ? chunkErrorMessage
                                : "Not attempted after earlier chunk failed",
                        ),
                    )
                }
                return BulkScanImportSummary(
                    inserted: totalInserted,
                    errors: allErrors,
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

    // MARK: - Bulk import idempotency backstop

    /// Identity key for the delta math. The bulk-import route stores
    /// canonical_slug / printing_id / grade verbatim (trimmed only), so
    /// what we send is what fetchHoldings() returns — exact string
    /// equality is safe. Each tray entry inserts exactly one holdings
    /// row (qty is a column, not a row multiplier), so counting rows
    /// per key measures inserts directly.
    private static func lotKey(slug: String?, printingId: String?, grade: String?) -> String {
        "\(slug ?? "")|\(printingId ?? "")|\(grade ?? "")"
    }

    private static func lotKey(for entry: MultiScanEntry) -> String {
        lotKey(slug: entry.match.slug, printingId: entry.printingId, grade: entry.grade)
    }

    private static func lotCountsByKey(_ holdings: [HoldingRow]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for h in holdings {
            counts[lotKey(slug: h.canonicalSlug, printingId: h.printingId, grade: h.grade), default: 0] += 1
        }
        return counts
    }

    /// Decides whether a chunk whose POST threw actually committed.
    /// Returns true only when every key the chunk would have inserted
    /// shows a full unexplained delta (rows present beyond the pre-
    /// import snapshot and the confirmed inserts from earlier chunks).
    /// Returns false when no key shows any delta, nil when the picture
    /// is mixed/partial (e.g. a concurrent add from another device) or
    /// the verification fetch itself failed — callers treat nil as
    /// "unknown" and fall back to the pessimistic retry path, which is
    /// today's behavior.
    private func failedChunkLanded(
        chunk: ArraySlice<MultiScanEntry>,
        preCounts: [String: Int],
        confirmedCounts: [String: Int],
    ) async -> Bool? {
        guard let current = try? await fetchHoldings() else { return nil }
        let postCounts = Self.lotCountsByKey(current)

        var expected: [String: Int] = [:]
        for entry in chunk {
            expected[Self.lotKey(for: entry), default: 0] += 1
        }

        var landedKeys = 0
        var missingKeys = 0
        for (key, need) in expected {
            let unexplained = (postCounts[key] ?? 0) - (preCounts[key] ?? 0) - (confirmedCounts[key] ?? 0)
            if unexplained >= need {
                landedKeys += 1
            } else if unexplained <= 0 {
                missingKeys += 1
            } else {
                return nil // partial delta — can't attribute safely
            }
        }
        if landedKeys > 0 && missingKeys == 0 { return true }
        if missingKeys > 0 && landedKeys == 0 { return false }
        return nil
    }

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
