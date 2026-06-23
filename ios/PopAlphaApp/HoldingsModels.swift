import Foundation

// MARK: - Holdings Models (matches /api/holdings response)

/// How a lot was added to the portfolio. Server stores as a plain
/// text column with a check constraint; iOS mirrors as an enum for
/// type-safe dispatch (e.g. showing an "Imported" chip on CSV lots).
enum HoldingSource: String, Decodable, Hashable {
    case manual
    case csvImport = "csv_import"
    case scanner

    /// Fallback for unknown future values so the decoder never throws.
    static let unknownFallback: HoldingSource = .manual
}

struct HoldingRow: Decodable, Identifiable, Hashable {
    /// Holdings.id is a UUID column on the server, so this is the
    /// raw UUID string. Earlier this was typed as Int with a hashValue
    /// fallback — that produced a meaningless integer that the server
    /// then rejected with "invalid input syntax for type uuid" when
    /// the client tried to PATCH/DELETE.
    let id: String
    let canonicalSlug: String?
    let printingId: String?
    let grade: String
    let qty: Int
    /// Optional — users can add a card without recording what they
    /// paid. nil means "unknown cost basis" and is treated as zero
    /// when summing for position-level totals (same convention as
    /// the server-side `?? 0` coercion), while the per-lot display
    /// shows "—" instead of "$0.00" to preserve the distinction.
    let pricePaidUsd: Double?
    let acquiredOn: String?
    let venue: String?
    let certNumber: String?
    /// Provenance: how this lot entered the portfolio. "manual" for
    /// AddHoldingSheet, "csv_import" for bulk CSV import, "scanner"
    /// reserved for future camera-capture flows. Defaults to "manual"
    /// in the DB so all historical rows retain their semantics.
    let source: HoldingSource

    var formattedCost: String {
        guard let price = pricePaidUsd else { return "—" }
        return "$\(String(format: "%.2f", price))"
    }

    /// Used by Position aggregation; nil cost counts as 0 here so a
    /// position mixing known and unknown lots still produces a
    /// sensible partial total.
    var totalCost: Double {
        (pricePaidUsd ?? 0) * Double(qty)
    }

    // Supabase may serialize bigint as string and numeric as string.
    // This custom decoder handles both representations.
    private enum CodingKeys: String, CodingKey {
        case id, canonicalSlug, printingId, grade, qty, pricePaidUsd, acquiredOn, venue, certNumber, source
    }

    /// Direct memberwise initializer for synthetic instances (demo
    /// preview data, tests). The custom Decodable initializer below
    /// remains the path the network layer uses.
    init(
        id: String,
        canonicalSlug: String?,
        printingId: String?,
        grade: String,
        qty: Int,
        pricePaidUsd: Double?,
        acquiredOn: String?,
        venue: String?,
        certNumber: String?,
        source: HoldingSource = .manual
    ) {
        self.id = id
        self.canonicalSlug = canonicalSlug
        self.printingId = printingId
        self.grade = grade
        self.qty = qty
        self.pricePaidUsd = pricePaidUsd
        self.acquiredOn = acquiredOn
        self.venue = venue
        self.certNumber = certNumber
        self.source = source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        // id: server returns a UUID string, but tolerate Int just in
        // case a future schema change brings back an integer key.
        if let strId = try? c.decode(String.self, forKey: .id) {
            id = strId
        } else if let intId = try? c.decode(Int.self, forKey: .id) {
            id = String(intId)
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .id,
                in: c,
                debugDescription: "holdings.id missing or wrong type"
            )
        }

        canonicalSlug = try c.decodeIfPresent(String.self, forKey: .canonicalSlug)
        printingId = try c.decodeIfPresent(String.self, forKey: .printingId)
        grade = (try? c.decode(String.self, forKey: .grade)) ?? "RAW"

        // qty: may arrive as Int or String
        if let intQty = try? c.decode(Int.self, forKey: .qty) {
            qty = intQty
        } else if let strQty = try? c.decode(String.self, forKey: .qty), let parsed = Int(strQty) {
            qty = parsed
        } else {
            qty = 1
        }

        // pricePaidUsd: may arrive as Double, String, or null/missing.
        // null/missing is preserved (see the property comment) — do NOT
        // substitute 0, because "unknown cost" and "$0 cost" are
        // different things to the user.
        if let dblPrice = try? c.decode(Double.self, forKey: .pricePaidUsd) {
            pricePaidUsd = dblPrice
        } else if let strPrice = try? c.decode(String.self, forKey: .pricePaidUsd), let parsed = Double(strPrice) {
            pricePaidUsd = parsed
        } else {
            pricePaidUsd = nil
        }

        acquiredOn = try c.decodeIfPresent(String.self, forKey: .acquiredOn)
        venue = try c.decodeIfPresent(String.self, forKey: .venue)
        certNumber = try c.decodeIfPresent(String.self, forKey: .certNumber)

        // Tolerate missing column (older API / cached response) or
        // unrecognized enum values (future-forward) by falling back to
        // manual. Matches the DB default so behavior stays predictable.
        if let raw = try? c.decodeIfPresent(String.self, forKey: .source),
           let parsed = HoldingSource(rawValue: raw) {
            source = parsed
        } else {
            source = HoldingSource.unknownFallback
        }
    }
}

struct HoldingsResponse: Decodable {
    let ok: Bool
    let holdings: [HoldingRow]
}

// MARK: - Position (grouped holdings)

struct Position: Identifiable, Hashable {
    let key: String
    let canonicalSlug: String?
    let grade: String
    let lots: [HoldingRow]

    var id: String { key }

    var totalQty: Int {
        lots.reduce(0) { $0 + $1.qty }
    }

    var costBasis: Double {
        lots.reduce(0) { $0 + $1.totalCost }
    }

    /// Quantity across lots that actually have a recorded cost. Used as
    /// the avgCost denominator so unknown-cost lots don't dilute the
    /// per-copy average toward zero (10 unknown lots + one $50 lot is a
    /// ~$50 card, not a $4.55 card).
    var knownCostQty: Int {
        lots.filter { $0.pricePaidUsd != nil }.reduce(0) { $0 + $1.qty }
    }

    /// True when at least one lot has no recorded cost basis — the
    /// position total is a known-lots-only partial, and the UI should
    /// say so instead of presenting it as the full cost.
    var hasUnknownCostLots: Bool {
        lots.contains { $0.pricePaidUsd == nil }
    }

    /// True when NO lot has a recorded cost — there is no cost basis to
    /// show at all, only a quantity.
    var allCostsUnknown: Bool {
        lots.allSatisfy { $0.pricePaidUsd == nil }
    }

    var avgCost: Double {
        knownCostQty > 0 ? costBasis / Double(knownCostQty) : 0
    }

    /// Key into the overview's `positionPrices` map. Mirrors the server's
    /// `${slug}::${printing_id ?? ""}::${grade}`. All lots in a position share
    /// one (printingId ?? slug, grade) bucket, so lots.first is representative.
    var positionPriceKey: String? {
        guard let slug = canonicalSlug else { return nil }
        return "\(slug)::\(lots.first?.printingId ?? "")::\(grade)"
    }

    /// Per-copy MARKET price for this position: the finish+grade-specific
    /// server price when available, else the slug-level canonical price.
    /// Returns nil when neither exists (callers either fall back to avgCost
    /// for ranking, or render cost basis instead) — deliberately no cost
    /// fallback so a card with no market signal still reads as "no price".
    func marketOnlyPrice(positionPrices: [String: Double]?, slugPrice: Double?) -> Double? {
        if let key = positionPriceKey, let p = positionPrices?[key] { return p }
        return slugPrice
    }

    var formattedAvgCost: String {
        allCostsUnknown ? "—" : "$\(String(format: "%.2f", avgCost))"
    }

    /// "—" when no lot has a cost, "$X.XX+" when only some do (the sum
    /// is a floor, not the true total), plain "$X.XX" when complete.
    var formattedCostBasis: String {
        if allCostsUnknown { return "—" }
        let base = "$\(String(format: "%.2f", costBasis))"
        return hasUnknownCostLots ? "\(base)+" : base
    }

    /// Group holdings into positions by (printingId ?? canonicalSlug) + grade
    static func group(_ holdings: [HoldingRow]) -> [Position] {
        var groups: [String: [HoldingRow]] = [:]

        for h in holdings {
            let cardKey = h.printingId ?? h.canonicalSlug ?? "unknown"
            let key = "\(cardKey)::\(h.grade)"
            groups[key, default: []].append(h)
        }

        return groups.map { key, lots in
            Position(
                key: key,
                canonicalSlug: lots.first?.canonicalSlug,
                grade: lots.first?.grade ?? "RAW",
                lots: lots.sorted { ($0.acquiredOn ?? "") > ($1.acquiredOn ?? "") }
            )
        }
        .sorted { $0.costBasis > $1.costBasis }
    }
}

// MARK: - Grade Options

enum GradeOption: String, CaseIterable, Identifiable {
    case raw = "RAW"
    case psa7 = "PSA 7"
    case psa8 = "PSA 8"
    case psa9 = "PSA 9"
    case psa10 = "PSA 10"
    case cgc9 = "CGC 9"
    case cgc95 = "CGC 9.5"
    case cgc10 = "CGC 10"
    case bgs9 = "BGS 9"
    case bgs95 = "BGS 9.5"
    case bgs10 = "BGS 10"

    var id: String { rawValue }
}

// MARK: - Simple OK Response

struct SimpleOKResponse: Decodable {
    let ok: Bool
}
