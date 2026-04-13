import Foundation

// MARK: - Holdings Models (matches /api/holdings response)

struct HoldingRow: Decodable, Identifiable, Hashable {
    let id: Int
    let canonicalSlug: String?
    let printingId: String?
    let grade: String
    let qty: Int
    let pricePaidUsd: Double
    let acquiredOn: String?
    let venue: String?
    let certNumber: String?

    var formattedCost: String {
        "$\(String(format: "%.2f", pricePaidUsd))"
    }

    var totalCost: Double {
        pricePaidUsd * Double(qty)
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

    var avgCost: Double {
        totalQty > 0 ? costBasis / Double(totalQty) : 0
    }

    var formattedAvgCost: String {
        "$\(String(format: "%.2f", avgCost))"
    }

    var formattedCostBasis: String {
        "$\(String(format: "%.2f", costBasis))"
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
