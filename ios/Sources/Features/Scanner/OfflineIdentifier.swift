// OfflineIdentifier.swift
//
// On-device port of the Day-2 layered OCR-first retrieval logic from
// `app/api/scan/identify/route.ts`. Given a query embedding plus
// optional OCR card_number / set_hint, picks Path A / B / C and
// returns matches + confidence + winning_path identical in shape to
// what the server returns — so iOS can swap server identification
// for offline identification without changing downstream UI code.
//
// PATH SUMMARY (mirrors route.ts lines 1180-1300):
//
//   Path A (strict)   — card_number + set_hint both present;
//                       canonical_cards filtered by both narrows to
//                       1-3 distinct slugs.
//                          1 → ocr_direct_unique  → HIGH
//                        2-3 → ocr_direct_narrow  → MEDIUM
//                         >3 → fall through to Path B
//
//   Path B (middle)   — card_number-only intersection of
//                       canonical_cards rows with kNN top-K survivors.
//                          1 → ocr_intersect_unique → HIGH
//                              (downgrades to MEDIUM if Path B forced
//                              an override of CLIP's original top-1
//                              — the Umbreon V #94 trust-killer.)
//                        2-3 → ocr_intersect_narrow → MEDIUM
//                         0 → fall through to Path C
//                         >3 → fall through to Path C (too noisy)
//
//   Path C (fallback) — vision_only. kNN top-K with optional post-
//                       filters; confidence by similarity threshold
//                       + gap-to-rank-2.
//
// IMPORTANT DEVIATIONS FROM SERVER:
//
//   1. Server filters kNN at SQL level (pgvector WHERE card_number=N
//      AND language=L AND crop_type='full'). Offline kNN runs over
//      the FULL catalog (no SQL); we apply equivalent filters as
//      POST-filters over a larger top-K pool (k=20 instead of 5).
//      This means a card that ranks #51 unfiltered but #1 filtered
//      can be missed. Acceptable for v1; revisit if eval drops.
//
//   2. canonical_cards table has cards we haven't embedded yet
//      (offline catalog ⊂ canonical_cards). Cards missing from the
//      catalog can't be identified offline at all. Premium tier
//      messaging should set this expectation up-front.
//
//   3. No `winning_crop` (full vs art). Offline catalog only carries
//      full-card embeddings for v1.

import Foundation

// MARK: - Public types

public enum OfflineWinningPath: String, Sendable {
    case visionOnly = "vision_only"
    case ocrDirectUnique = "ocr_direct_unique"
    case ocrDirectNarrow = "ocr_direct_narrow"
    case ocrIntersectUnique = "ocr_intersect_unique"
    case ocrIntersectNarrow = "ocr_intersect_narrow"
}

public enum OfflineScanConfidence: String, Sendable {
    case high
    case medium
    case low
}

/// One match in the response. `cosDistance` is `1 - similarity` so
/// callers that already think in distance space (the server's
/// pgvector idiom) can use it without re-deriving.
public struct OfflineIdentifyMatch: Sendable {
    public let row: OfflineCatalogRow
    public let similarity: Float
    public let cosDistance: Float
    public let source: Source

    public enum Source: String, Sendable {
        /// From kNN top-K (CLIP/SigLIP cosine search).
        case knn
        /// From a direct catalog metadata lookup (Path A unique only).
        /// `similarity` is a sentinel 1.0 because the slug was selected
        /// by OCR + DB, not by embedding distance.
        case ocrDirect
    }
}

/// Inputs to the identifier. `queryEmbedding` MUST be L2-normalized
/// 768-d float — caller (OfflineEmbedder) handles normalization.
public struct OfflineIdentifyRequest: Sendable {
    public let queryEmbedding: [Float]
    public let language: String           // "EN" or "JP" (unused if catalog is single-language)
    public let ocrCardNumber: String?     // raw OCR — parsed internally
    public let ocrSetHint: String?        // raw OCR — parsed internally
    public let limit: Int                 // top-K to return on Path C; default 5

    public init(
        queryEmbedding: [Float],
        language: String = "EN",
        ocrCardNumber: String? = nil,
        ocrSetHint: String? = nil,
        limit: Int = 5,
    ) {
        self.queryEmbedding = queryEmbedding
        self.language = language
        self.ocrCardNumber = ocrCardNumber
        self.ocrSetHint = ocrSetHint
        self.limit = limit
    }
}

/// Full result envelope. Telemetry fields mirror what
/// route.ts logs to scan_identify_events so iOS callers can produce
/// identical PostHog events for offline identifications later.
public struct OfflineIdentifyResult: Sendable {
    public let matches: [OfflineIdentifyMatch]
    public let confidence: OfflineScanConfidence
    public let winningPath: OfflineWinningPath
    public let topSimilarity: Float?
    public let topGap: Float?
    public let durationMs: Double

    // Telemetry / diagnostics
    public let cardNumberFilterApplied: Bool
    public let setHintFilterApplied: Bool
    public let cardNumberFilterDroppedAll: Bool
    /// CLIP's true top-1 BEFORE any OCR filtering. Used to detect
    /// trust-killer overrides ("OCR forced a different answer than
    /// CLIP's strongest signal") which the server-side route demotes
    /// to MEDIUM.
    public let clipOriginalTopSlug: String?
}

// MARK: - Identifier

public final class OfflineIdentifier {
    public let catalog: OfflineCatalog
    public let knn: OfflineKNN

    /// Confidence thresholds — must match route.ts lines 97-99.
    /// Server uses cos_distance (= 1 - similarity); we keep distance
    /// space here so the same constants apply directly.
    public static let highCosDist: Float = 0.25       // similarity ≥ 0.75
    public static let mediumCosDist: Float = 0.30     // similarity ≥ 0.70
    public static let highMinGap: Float = 0.04

    /// Larger pool for Path B intersection. Server uses pgvector
    /// limit≈20 for the kNN candidate pool; matching that here keeps
    /// recall comparable in the offline path. Final response is sliced
    /// to `request.limit` (default 5).
    public static let candidatePoolSize: Int = 20

    public init(catalog: OfflineCatalog, knn: OfflineKNN) {
        self.catalog = catalog
        self.knn = knn
    }

    /// Multi-candidate variant. Tries each `cardNumberCandidate` in
    /// turn (most-confident OCR reading first), returning the FIRST
    /// result that fired Path A or Path B (i.e., OCR + DB found a
    /// narrow match). Falls back to running Path C with the top
    /// candidate when none of them yield a non-vision_only result —
    /// this preserves the existing trust-killer demote behavior for
    /// genuinely-disagreeing OCR.
    ///
    /// Use this from the orchestrator when OCR returns multiple
    /// plausible readings (Vision's topCandidates(3) is the source).
    /// For single-candidate callers, just use `identify(_:)` directly.
    public func identifyWithCandidates(
        queryEmbedding: [Float],
        language: String,
        cardNumberCandidates: [String],
        ocrSetHint: String?,
        limit: Int,
    ) -> OfflineIdentifyResult {
        // No candidates → just run Path C.
        if cardNumberCandidates.isEmpty {
            return identify(.init(
                queryEmbedding: queryEmbedding,
                language: language,
                ocrCardNumber: nil,
                ocrSetHint: ocrSetHint,
                limit: limit,
            ))
        }

        // Try each in OCR-confidence order. First one to fire Path A
        // or B wins. Doing the full identify per candidate is cheap
        // (~5-15ms each) compared to the embed step (~36ms on ANE),
        // and we typically have ≤3 candidates.
        for cardNumber in cardNumberCandidates {
            let result = identify(.init(
                queryEmbedding: queryEmbedding,
                language: language,
                ocrCardNumber: cardNumber,
                ocrSetHint: ocrSetHint,
                limit: limit,
            ))
            if result.winningPath != .visionOnly {
                return result
            }
        }
        // None of the candidates yielded a non-vision_only path.
        // Run Path C with the top candidate so the trust-killer
        // logic (cardNumberFilterDroppedAll → MEDIUM demote) still
        // fires for genuinely-disagreeing OCR.
        return identify(.init(
            queryEmbedding: queryEmbedding,
            language: language,
            ocrCardNumber: cardNumberCandidates.first,
            ocrSetHint: ocrSetHint,
            limit: limit,
        ))
    }

    /// Run the full pipeline. Synchronous — vDSP kNN + linear catalog
    /// scan are fast enough on Apple Silicon (<50ms total) that
    /// async overhead would dominate.
    public func identify(_ request: OfflineIdentifyRequest) -> OfflineIdentifyResult {
        let startedAt = Date()
        #if DEBUG
        let dbg = ProcessInfo.processInfo.arguments.contains("-debugOfflineIdentifier")
        #endif

        let normalizedNumber = OfflineIdentifier.parseCardNumberFilter(request.ocrCardNumber)
        let normalizedHint = OfflineIdentifier.parseSetHintFilter(request.ocrSetHint)
        let cardNumberFilterApplied = normalizedNumber != nil
        let setHintFilterApplied = normalizedHint != nil

        // -- kNN top-K over full catalog --
        // Larger pool than the response limit so Path B has enough
        // candidates for an intersection to find a survivor that
        // wasn't in the top-5.
        let poolK = max(OfflineIdentifier.candidatePoolSize, request.limit)
        let knnHits = knn.topK(query: request.queryEmbedding, k: poolK)
        let clipOriginalTopSlug = knnHits.first?.row.canonicalSlug

        // -- Direct catalog lookup by language + card_number --
        // Mirrors route.ts's `directQuery` against canonical_cards.
        // Bounded scan (linear over rows array) — fine for 23k rows.
        var directRows: [OfflineCatalogRow] = []
        if cardNumberFilterApplied, let target = normalizedNumber {
            let langMatch = request.language.uppercased()
            for row in catalog.rows {
                if let lang = row.language, !lang.isEmpty {
                    if lang.uppercased() != langMatch { continue }
                }
                let storedNum = OfflineIdentifier.normalizeCardNumberForCompare(row.cardNumber)
                if storedNum == target {
                    directRows.append(row)
                }
            }
        }
        #if DEBUG
        if dbg {
            let directDistinct = Set(directRows.map { $0.canonicalSlug }).count
            print("[identify.dbg] hint=\(normalizedHint ?? "nil") num=\(normalizedNumber ?? "nil") lang=\(request.language) directRows=\(directRows.count) directDistinct=\(directDistinct) clipTop=\(clipOriginalTopSlug ?? "nil")")
        }
        #endif

        // -- Try Path A (strict: card_number + set_hint) --
        if let hint = normalizedHint, !directRows.isEmpty {
            let setMatching = directRows.filter { row in
                OfflineIdentifier.setHintMatches(hint: hint, storedSetName: row.setName)
            }
            // Distinct slugs — multiple variant rows per slug shouldn't
            // inflate the "narrowed to N" count.
            let uniqueSlugs = Self.distinctSlugs(setMatching)
            #if DEBUG
            if dbg {
                print("[identify.dbg.A] setMatching=\(setMatching.count) uniqueSlugs=\(uniqueSlugs.count) sample=\(uniqueSlugs.prefix(3))")
            }
            #endif
            if uniqueSlugs.count == 1 {
                let slug = uniqueSlugs.first!
                let row = setMatching.first { $0.canonicalSlug == slug }!
                let match = OfflineIdentifyMatch(
                    row: row,
                    similarity: 1.0,
                    cosDistance: 0.0,
                    source: .ocrDirect,
                )
                return result(
                    matches: [match],
                    confidence: .high,
                    winningPath: .ocrDirectUnique,
                    cardNumberFilterApplied: cardNumberFilterApplied,
                    setHintFilterApplied: setHintFilterApplied,
                    cardNumberFilterDroppedAll: false,
                    clipOriginalTopSlug: clipOriginalTopSlug,
                    startedAt: startedAt,
                )
            } else if uniqueSlugs.count >= 2 && uniqueSlugs.count <= 3 {
                // Rank by kNN similarity if present; sentinel 0.5 sim
                // for slugs absent from kNN top-K (mirrors server's
                // `cos_dist=0.5` sentinel for Path A narrow).
                let knnBySlug = Self.firstHitBySlug(knnHits)
                let ranked: [OfflineIdentifyMatch] = uniqueSlugs.compactMap { slug in
                    if let hit = knnBySlug[slug] {
                        return OfflineIdentifyMatch(
                            row: hit.row,
                            similarity: hit.similarity,
                            cosDistance: 1.0 - hit.similarity,
                            source: .knn,
                        )
                    }
                    // Pull a representative variant row from setMatching.
                    guard let row = setMatching.first(where: { $0.canonicalSlug == slug }) else {
                        return nil
                    }
                    return OfflineIdentifyMatch(
                        row: row,
                        similarity: 0.5,
                        cosDistance: 0.5,
                        source: .ocrDirect,
                    )
                }
                .sorted { $0.similarity > $1.similarity }
                let limited = Array(ranked.prefix(request.limit))
                return result(
                    matches: limited,
                    confidence: .medium,
                    winningPath: .ocrDirectNarrow,
                    cardNumberFilterApplied: cardNumberFilterApplied,
                    setHintFilterApplied: setHintFilterApplied,
                    cardNumberFilterDroppedAll: false,
                    clipOriginalTopSlug: clipOriginalTopSlug,
                    startedAt: startedAt,
                )
            }
            // setMatching empty or >3 → fall through to Path B
        }

        // -- Try Path B (intersect kNN with card_number-only directRows) --
        if cardNumberFilterApplied && !directRows.isEmpty {
            let directSlugs = Set(directRows.map { $0.canonicalSlug })
            // dedupeBySlug while preserving kNN ordering — first hit
            // for each slug wins.
            var seen = Set<String>()
            var intersect: [OfflineKNNHit] = []
            for hit in knnHits where directSlugs.contains(hit.row.canonicalSlug) {
                if seen.insert(hit.row.canonicalSlug).inserted {
                    intersect.append(hit)
                }
            }
            #if DEBUG
            if dbg {
                let knnSlugs = Self.dedupeBySlugPreservingOrder(knnHits).prefix(5).map { $0.row.canonicalSlug }
                print("[identify.dbg.B] intersect=\(intersect.count) knnTop5Slugs=\(Array(knnSlugs)) directSlugCount=\(directSlugs.count)")
            }
            #endif
            if intersect.count == 1 {
                let hit = intersect[0]
                let match = OfflineIdentifyMatch(
                    row: hit.row,
                    similarity: hit.similarity,
                    cosDistance: 1.0 - hit.similarity,
                    source: .knn,
                )
                // Trust-killer guard: if Path B's unique survivor is
                // NOT CLIP's natural top-1, OCR forced an override —
                // demote to MEDIUM so the picker surfaces the
                // disagreement (mirrors route.ts line 1363).
                let pathBChangedTop1 =
                    clipOriginalTopSlug != nil
                    && match.row.canonicalSlug != clipOriginalTopSlug
                let confidence: OfflineScanConfidence = pathBChangedTop1 ? .medium : .high
                return result(
                    matches: [match],
                    confidence: confidence,
                    winningPath: .ocrIntersectUnique,
                    cardNumberFilterApplied: cardNumberFilterApplied,
                    setHintFilterApplied: setHintFilterApplied,
                    cardNumberFilterDroppedAll: false,
                    clipOriginalTopSlug: clipOriginalTopSlug,
                    startedAt: startedAt,
                )
            } else if intersect.count >= 2 && intersect.count <= 3 {
                let matches = intersect.prefix(request.limit).map { hit in
                    OfflineIdentifyMatch(
                        row: hit.row,
                        similarity: hit.similarity,
                        cosDistance: 1.0 - hit.similarity,
                        source: .knn,
                    )
                }
                return result(
                    matches: Array(matches),
                    confidence: .medium,
                    winningPath: .ocrIntersectNarrow,
                    cardNumberFilterApplied: cardNumberFilterApplied,
                    setHintFilterApplied: setHintFilterApplied,
                    cardNumberFilterDroppedAll: false,
                    clipOriginalTopSlug: clipOriginalTopSlug,
                    startedAt: startedAt,
                )
            }
            // intersect.count == 0 → fall through (filter dropped all)
            // intersect.count > 3  → fall through (too noisy)
        }

        // -- Path C: vision_only with optional post-filters --
        // Apply card_number / set_hint as POST-filters over the kNN
        // top-K. Track whether the filter dropped every candidate
        // (`cardNumberFilterDroppedAll`) so classifyConfidence can
        // demote — same trust-killer rule as the server.
        var filtered = knnHits
        let unfilteredTop = filtered.first?.row.canonicalSlug
        if let target = normalizedNumber {
            filtered = filtered.filter { hit in
                OfflineIdentifier.normalizeCardNumberForCompare(hit.row.cardNumber) == target
            }
        }
        if let hint = normalizedHint {
            filtered = filtered.filter { hit in
                OfflineIdentifier.setHintMatches(hint: hint, storedSetName: hit.row.setName)
            }
        }
        let cardNumberFilterDroppedAll =
            cardNumberFilterApplied && filtered.isEmpty && !knnHits.isEmpty

        // If filters dropped EVERY candidate, fall back to unfiltered
        // (so users still get a top-K picker), with telemetry tagged.
        if filtered.isEmpty {
            filtered = knnHits
        }

        // Dedupe by slug, then trim to the response limit.
        filtered = Self.dedupeBySlugPreservingOrder(filtered)
        let trimmed = Array(filtered.prefix(request.limit))
        let matches: [OfflineIdentifyMatch] = trimmed.map { hit in
            OfflineIdentifyMatch(
                row: hit.row,
                similarity: hit.similarity,
                cosDistance: 1.0 - hit.similarity,
                source: .knn,
            )
        }
        let topDist = matches.first.map { 1.0 - $0.similarity }
        let gap: Float? = {
            guard matches.count >= 2 else { return nil }
            return matches[0].similarity - matches[1].similarity
        }()
        let ocrChangedTop1 =
            (cardNumberFilterApplied || setHintFilterApplied)
            && unfilteredTop != nil
            && matches.first.map { $0.row.canonicalSlug != unfilteredTop } ?? false
        let confidence = OfflineIdentifier.classifyConfidence(
            topCosDistance: topDist.map { Float($0) },
            gap: gap,
            cardNumberFilterApplied: cardNumberFilterApplied || setHintFilterApplied,
            ocrChangedTop1: ocrChangedTop1,
            cardNumberFilterDroppedAll: cardNumberFilterDroppedAll,
        )

        return result(
            matches: matches,
            confidence: confidence,
            winningPath: .visionOnly,
            cardNumberFilterApplied: cardNumberFilterApplied,
            setHintFilterApplied: setHintFilterApplied,
            cardNumberFilterDroppedAll: cardNumberFilterDroppedAll,
            clipOriginalTopSlug: clipOriginalTopSlug,
            startedAt: startedAt,
        )
    }

    // MARK: - Result builder

    private func result(
        matches: [OfflineIdentifyMatch],
        confidence: OfflineScanConfidence,
        winningPath: OfflineWinningPath,
        cardNumberFilterApplied: Bool,
        setHintFilterApplied: Bool,
        cardNumberFilterDroppedAll: Bool,
        clipOriginalTopSlug: String?,
        startedAt: Date,
    ) -> OfflineIdentifyResult {
        let topSim = matches.first?.similarity
        let gap: Float? = {
            guard matches.count >= 2 else { return nil }
            return matches[0].similarity - matches[1].similarity
        }()
        return OfflineIdentifyResult(
            matches: matches,
            confidence: confidence,
            winningPath: winningPath,
            topSimilarity: topSim,
            topGap: gap,
            durationMs: Date().timeIntervalSince(startedAt) * 1000,
            cardNumberFilterApplied: cardNumberFilterApplied,
            setHintFilterApplied: setHintFilterApplied,
            cardNumberFilterDroppedAll: cardNumberFilterDroppedAll,
            clipOriginalTopSlug: clipOriginalTopSlug,
        )
    }

    // MARK: - Dedupe helpers

    private static func distinctSlugs(_ rows: [OfflineCatalogRow]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for row in rows where seen.insert(row.canonicalSlug).inserted {
            out.append(row.canonicalSlug)
        }
        return out
    }

    private static func firstHitBySlug(_ hits: [OfflineKNNHit]) -> [String: OfflineKNNHit] {
        var out: [String: OfflineKNNHit] = [:]
        for hit in hits where out[hit.row.canonicalSlug] == nil {
            out[hit.row.canonicalSlug] = hit
        }
        return out
    }

    private static func dedupeBySlugPreservingOrder(_ hits: [OfflineKNNHit]) -> [OfflineKNNHit] {
        var seen = Set<String>()
        var out: [OfflineKNNHit] = []
        for hit in hits where seen.insert(hit.row.canonicalSlug).inserted {
            out.append(hit)
        }
        return out
    }
}

// MARK: - OCR / set-hint parsing helpers
// Direct ports of route.ts:300-387. KEEP IN SYNC if either side
// changes — divergence here means iOS-offline and server identify
// disagree on whether a filter applied.

extension OfflineIdentifier {
    /// Parse a printed collector number into the form
    /// canonical_cards stores. See route.ts:300.
    public static func parseCardNumberFilter(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        // Match "#?  ([A-Za-z0-9]+)  /  [A-Za-z0-9]+"
        if let head = matchHead(trimmed, pattern: "^#?\\s*([A-Za-z0-9]+)\\s*\\/\\s*[A-Za-z0-9]+") {
            return stripLeadingZerosIfDigits(head)
        }
        if let head = matchHead(trimmed, pattern: "^#?\\s*([A-Za-z0-9]+)") {
            return stripLeadingZerosIfDigits(head)
        }
        return trimmed
    }

    /// Same rules as `parseCardNumberFilter` but applied to
    /// canonical-side values. Strips the `/total` printed suffix
    /// because our offline catalog is built from
    /// card_image_embeddings, which stores the printed form
    /// ("050a/147"), while OCR input + the server's canonical_cards
    /// table use the slash-free form ("050a"). Without this strip,
    /// "050a" filter would never match "050a/147" stored value.
    /// Server-side this divergence doesn't surface because the route
    /// only queries canonical_cards, never card_image_embeddings.
    public static func normalizeCardNumberForCompare(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        // If there's a "/total" suffix, keep only the numerator.
        // Mirrors parseCardNumberFilter's regex behavior.
        let head: String
        if let slashIdx = trimmed.firstIndex(of: "/") {
            head = String(trimmed[..<slashIdx])
        } else {
            head = trimmed
        }
        let cleanHead = head.trimmingCharacters(in: .whitespaces)
        if cleanHead.isEmpty { return nil }
        return stripLeadingZerosIfDigits(cleanHead)
    }

    /// Normalize a free-text set hint. Matches route.ts:333-343.
    /// Returns nil for ≤2 chars (pure OCR noise).
    public static func parseSetHintFilter(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let normalized = normalizeForSetCompare(raw)
        return normalized.count < 3 ? nil : normalized
    }

    public static func normalizeSetNameForCompare(_ raw: String?) -> String {
        guard let raw else { return "" }
        return normalizeForSetCompare(raw)
    }

    /// True if the OCR set hint plausibly refers to `storedSetName`.
    /// UNIDIRECTIONAL: stored.contains(hint), not the reverse — the
    /// reverse caused a HIGH-confidence false positive on flavor text
    /// containing the word "Fossil" (route.ts:355-376).
    public static func setHintMatches(hint: String, storedSetName: String?) -> Bool {
        if hint.isEmpty { return true }
        let stored = normalizeSetNameForCompare(storedSetName)
        if stored.isEmpty { return false }
        // Reject when hint is dramatically longer than the stored name —
        // almost certainly flavor text that incidentally contains the
        // canonical name.
        if Float(hint.count) > Float(stored.count) * 1.5 + 4 { return false }
        return stored.contains(hint)
    }

    // MARK: - Confidence classification

    /// Direct port of route.ts:389-441. `topCosDistance` is in
    /// distance space (1 - similarity); thresholds are the same
    /// constants the server uses.
    public static func classifyConfidence(
        topCosDistance: Float?,
        gap: Float?,
        cardNumberFilterApplied: Bool,
        ocrChangedTop1: Bool,
        cardNumberFilterDroppedAll: Bool,
    ) -> OfflineScanConfidence {
        guard let topDistance = topCosDistance else { return .low }
        if topDistance <= highCosDist {
            // OCR/CLIP disagreement: filter was applied but dropped
            // every candidate → demote to MEDIUM (route.ts:418-420).
            if cardNumberFilterApplied && cardNumberFilterDroppedAll {
                return .medium
            }
            // Trust-killer (route.ts:433-435): if OCR narrowed the
            // candidate pool to exactly 1 (gap is null) AND that
            // surviving candidate replaced CLIP's original top-1,
            // demote to MEDIUM.
            if cardNumberFilterApplied && ocrChangedTop1 && gap == nil {
                return .medium
            }
            // gap-null = uncontested rank-1 → high (route.ts:436).
            if gap == nil { return .high }
            if let g = gap, g >= highMinGap { return .high }
            return .medium
        }
        if topDistance <= mediumCosDist { return .medium }
        return .low
    }

    // MARK: - Internal helpers

    /// Lowercase, strip non-letter/number, collapse whitespace.
    /// Matches route.ts:347-352 (which uses Unicode property classes).
    private static func normalizeForSetCompare(_ raw: String) -> String {
        var s = raw.lowercased()
        // Replace anything that isn't a letter or number with a space.
        let scalars = s.unicodeScalars.map { scalar -> Character in
            if scalar.properties.isAlphabetic
                || ("0"..."9").contains(scalar)
                || (CharacterSet.decimalDigits.contains(scalar))
            {
                return Character(scalar)
            }
            return " "
        }
        s = String(scalars)
        // Collapse runs of whitespace, trim.
        let collapsed = s.split(whereSeparator: { $0 == " " }).joined(separator: " ")
        return collapsed.trimmingCharacters(in: .whitespaces)
    }

    /// Run a regex and return the first capture group, or nil.
    private static func matchHead(_ s: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(s.startIndex..., in: s)
        guard let match = regex.firstMatch(in: s, range: range), match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: s) else {
            return nil
        }
        return String(s[captureRange])
    }

    /// "070" → "70", "TG04" → "TG04", "abc" → "abc".
    private static func stripLeadingZerosIfDigits(_ s: String) -> String {
        guard s.allSatisfy({ $0.isASCII && $0.isNumber }) else { return s }
        var trimmed = s
        while trimmed.count > 1 && trimmed.first == "0" {
            trimmed.removeFirst()
        }
        return trimmed
    }
}
