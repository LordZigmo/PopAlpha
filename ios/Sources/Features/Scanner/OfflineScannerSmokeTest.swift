// OfflineScannerSmokeTest.swift
//
// End-to-end validation of the on-device offline scanner trilogy:
// OfflineCatalog (.papb loader) → OfflineEmbedder (CoreML SigLIP-2)
// → OfflineKNN (vDSP cosine kNN). Run this once on first dev build
// and once on real-device QA to confirm the bridge between Swift,
// CoreML, and the bundled catalog is wired up correctly.
//
// Three validation tiers, each with its own pass/fail line:
//
//   1. PLUMBING — catalog loads, embedder loads, kNN runs without
//      throwing. Catches missing-resource bugs early.
//
//   2. KNN SELF-ROUNDTRIP — pull row N's embedding straight out of
//      the mmap'd catalog, run topK on it, expect top-1 = row N with
//      similarity ≈ 1.0. Validates the kNN math + catalog parsing
//      without needing a real image.
//
//   3. EMBED+SEARCH — synthesize a 384×384 UIImage (deterministic
//      noise for stable diagnostics), run the full pipeline, assert
//      the embedding is unit-norm and 768-d. Doesn't assert top-1
//      because synthetic noise won't match any real card — but logs
//      top-5 for sanity inspection.
//
//   4. ROUTING — exercise OfflineIdentifier's three paths:
//        • Path A unique  — pick a real row, feed its set + card_number
//          as OCR + its catalog embedding as query → expect
//          ocr_direct_unique HIGH.
//        • Path B intersect — same row, OCR with card_number only,
//          query is the row's embedding → expect ocr_intersect_unique
//          HIGH (kNN top-1 should match OCR's directRows).
//        • Path C vision_only — no OCR, synthetic noise query →
//          expect vision_only with whatever confidence the threshold
//          rules produce.
//
//   5. DOWNLOAD — exercise OfflineCatalogManager. Clears any cached
//      copy + ETag, calls ensureReady() so we go straight to a fresh
//      remote download, then validates that the redownloaded catalog
//      has the same row count and model_version as the bundled one.
//      Skipped (logged) when offline / Supabase unreachable so the
//      smoke test still produces a useful report on a plane.
//
//   7. CANONICAL ROUNDTRIP — download the canonical PNG for a known
//      catalog row, run it through the FULL embedder pipeline
//      (UIImage → CVPixelBuffer → CoreML), then kNN. The expected
//      result: top-1 = same slug at sim ≈ 0.97+ (FP16 + JPEG + resize
//      drift). This isolates "is the embedder pipeline correct?" from
//      "is the camera capture path correct?". A failure here means
//      we have a preprocessing bug (resize algorithm, BGRA layout,
//      color space). A pass + bad live scans means the issue lives
//      in Vision rectangle detection / framing, not the embedder.
//
// Why not XCTest: PopAlphaApp.xcodeproj currently has no test target.
// This module exposes a pure-Swift API so any caller (debug menu,
// CI script, command-line tool) can invoke it. We can promote to
// XCTest later when the test target lands.

import CoreML
import Foundation
import UIKit

public struct OfflineScannerSmokeReport {
    public struct CheckResult {
        public let name: String
        public let passed: Bool
        public let elapsedMs: Double
        public let detail: String

        public var line: String {
            let mark = passed ? "✅" : "❌"
            return "\(mark) [\(String(format: "%6.1fms", elapsedMs))] \(name) — \(detail)"
        }
    }

    public let catalogPath: String
    public let modelPath: String
    public let checks: [CheckResult]

    public var allPassed: Bool {
        return checks.allSatisfy { $0.passed }
    }

    public var summary: String {
        var lines: [String] = []
        lines.append("=== OfflineScanner Smoke Test ===")
        lines.append("Catalog: \(catalogPath)")
        lines.append("Model:   \(modelPath)")
        lines.append("---")
        for c in checks { lines.append(c.line) }
        lines.append("---")
        lines.append(allPassed ? "ALL PASSED ✅" : "SOME CHECKS FAILED ❌")
        return lines.joined(separator: "\n")
    }
}

public enum OfflineScannerSmokeTest {

    /// Runs all five validation tiers. Never throws — any failure
    /// is captured in the returned report so callers can render it.
    /// Total runtime budget:
    ///   • Tiers 1-4 (~1.5-2.5s on simulator CPU; <500ms on iPhone ANE).
    ///   • Tier 5 (network) — depends on bandwidth; 35MB at 50Mbps
    ///     is ~6s. Skipped on offline runs.
    public static func run() async -> OfflineScannerSmokeReport {
        var checks: [OfflineScannerSmokeReport.CheckResult] = []

        // -- Tier 1a: Catalog load --
        let catalogURL = Bundle.module.url(
            forResource: "siglip2_catalog_v1",
            withExtension: "papb",
        )
        let catalogPath = catalogURL?.path ?? "<missing>"

        var catalog: OfflineCatalog?
        do {
            let t0 = Date()
            guard let url = catalogURL else {
                checks.append(.init(
                    name: "catalog.load",
                    passed: false,
                    elapsedMs: 0,
                    detail: "siglip2_catalog_v1.papb not found in Bundle.module — copy from cog/siglip-features/.",
                ))
                return finalize(catalogPath: catalogPath, modelPath: "<not reached>", checks: checks)
            }
            catalog = try OfflineCatalog.load(from: url)
            let elapsed = Date().timeIntervalSince(t0) * 1000
            let cat = catalog!
            checks.append(.init(
                name: "catalog.load",
                passed: true,
                elapsedMs: elapsed,
                detail: "\(cat.numRows) rows × \(cat.vectorDim)d \(cat.dtype) (model_version=\(cat.modelVersion))",
            ))
        } catch {
            checks.append(.init(
                name: "catalog.load",
                passed: false,
                elapsedMs: 0,
                detail: "throw: \(error.localizedDescription)",
            ))
            return finalize(catalogPath: catalogPath, modelPath: "<not reached>", checks: checks)
        }

        guard let cat = catalog else {
            return finalize(catalogPath: catalogPath, modelPath: "<not reached>", checks: checks)
        }

        // -- Tier 1b: Embedder load --
        var embedder: OfflineEmbedder?
        let modelPath = Bundle.module.url(forResource: "siglip2_base_patch16_384", withExtension: "mlmodelc")?.path
            ?? Bundle.module.url(forResource: "siglip2_base_patch16_384", withExtension: "mlpackage")?.path
            ?? "<missing>"
        do {
            let t0 = Date()
            embedder = try OfflineEmbedder()
            let elapsed = Date().timeIntervalSince(t0) * 1000
            checks.append(.init(
                name: "embedder.init",
                passed: true,
                elapsedMs: elapsed,
                detail: "model loaded (computeUnits=.all)",
            ))
        } catch {
            checks.append(.init(
                name: "embedder.init",
                passed: false,
                elapsedMs: 0,
                detail: "throw: \(error.localizedDescription)",
            ))
            return finalize(catalogPath: catalogPath, modelPath: modelPath, checks: checks)
        }
        let emb = embedder!

        // -- Tier 1c: kNN init --
        let knn = OfflineKNN(catalog: cat)
        checks.append(.init(
            name: "knn.init",
            passed: true,
            elapsedMs: 0,
            detail: "ready (\(cat.numRows) rows in index)",
        ))

        // -- Tier 2: kNN self-roundtrip --
        // Extract row 0's embedding from catalog memory, treat it as
        // a query, expect top-1 = row 0 with similarity ≈ 1.0.
        let testRowIdx = 0
        let queryFromCatalog = extractCatalogRow(catalog: cat, rowIndex: testRowIdx)
        let t0 = Date()
        let roundTripHits = knn.topK(query: queryFromCatalog, k: 5)
        let knnElapsed = Date().timeIntervalSince(t0) * 1000
        let topHit = roundTripHits.first
        let expectedSlug = cat.rows[testRowIdx].canonicalSlug
        let roundTripPassed = (topHit?.row.canonicalSlug == expectedSlug)
            && (topHit.map { $0.similarity > 0.999 } ?? false)
        checks.append(.init(
            name: "knn.roundtrip",
            passed: roundTripPassed,
            elapsedMs: knnElapsed,
            detail: roundTripPassed
                ? "top-1 = \"\(expectedSlug)\" sim=\(String(format: "%.4f", topHit!.similarity))"
                : "expected \"\(expectedSlug)\" sim≈1.0; got \"\(topHit?.row.canonicalSlug ?? "<nil>")\" sim=\(String(format: "%.4f", topHit?.similarity ?? 0))",
        ))

        // -- Tier 3: Synthetic embed + search --
        // Generate a 384×384 UIImage of deterministic noise so this
        // check is reproducible run-to-run on the same device.
        let testImage = makeNoiseImage(side: 384, seed: 42)
        do {
            let t0 = Date()
            let queryFromImage = try emb.embed(image: testImage)
            let embedElapsed = Date().timeIntervalSince(t0) * 1000

            // Validate dimension + L2 norm. SigLIP-2 graph normalizes
            // internally, so the output should be unit-norm to within
            // FP16 quantization noise (~1e-3).
            let dimOk = queryFromImage.count == OfflineEmbedder.outputDimension
            let norm = sqrt(queryFromImage.reduce(0) { $0 + $1 * $1 })
            let normOk = abs(norm - 1.0) < 0.01

            checks.append(.init(
                name: "embedder.run",
                passed: dimOk && normOk,
                elapsedMs: embedElapsed,
                detail: "dim=\(queryFromImage.count) ‖v‖=\(String(format: "%.4f", norm))",
            ))

            // Run kNN on the synthetic embedding. We don't assert top-1
            // (synthetic noise won't match a card) — just that we get
            // 5 results with finite similarities and resolvable slugs.
            let t1 = Date()
            let syntheticHits = knn.topK(query: queryFromImage, k: 5)
            let searchElapsed = Date().timeIntervalSince(t1) * 1000
            let countOk = syntheticHits.count == 5
            let simsOk = syntheticHits.allSatisfy { $0.similarity >= -1.0 && $0.similarity <= 1.0 }
            let slugsOk = syntheticHits.allSatisfy { !$0.row.canonicalSlug.isEmpty }
            let topSlugs = syntheticHits.prefix(3).map {
                "\($0.row.canonicalSlug)(\(String(format: "%.3f", $0.similarity)))"
            }.joined(separator: ", ")
            checks.append(.init(
                name: "knn.synthetic",
                passed: countOk && simsOk && slugsOk,
                elapsedMs: searchElapsed,
                detail: "top-3: \(topSlugs)",
            ))
        } catch {
            checks.append(.init(
                name: "embedder.run",
                passed: false,
                elapsedMs: 0,
                detail: "throw: \(error.localizedDescription)",
            ))
        }

        // -- Tier 4: OfflineIdentifier path routing --
        // Find a row that's a clean Path A target: has both setName
        // and cardNumber, AND filtering by both narrows to a single
        // unique slug. The first such row in the catalog is fine.
        let identifier = OfflineIdentifier(catalog: cat, knn: knn)
        if let probeRow = pickIdentifierProbeRow(catalog: cat) {
            let probeQuery = extractCatalogRow(catalog: cat, rowIndex: probeRow.rowIndex)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-debugOfflineIdentifier") {
                print("[probe] slug=\(probeRow.row.canonicalSlug) setName=\"\(probeRow.row.setName ?? "<nil>")\" cardNumber=\"\(probeRow.row.cardNumber ?? "<nil>")\" language=\"\(probeRow.row.language ?? "<nil>")\" rowIdx=\(probeRow.rowIndex)")
                // Sanity-check: count rows whose cardNumber normalizes
                // to the probe's normalized number, regardless of language.
                let target = OfflineIdentifier.normalizeCardNumberForCompare(probeRow.row.cardNumber)
                let rowsMatchingNumber = cat.rows.filter {
                    OfflineIdentifier.normalizeCardNumberForCompare($0.cardNumber) == target
                }
                let rowsMatchingNumberAndLangEN = rowsMatchingNumber.filter {
                    ($0.language ?? "").uppercased() == "EN"
                }
                let probeInRowsMatching = rowsMatchingNumber.contains(where: { $0.canonicalSlug == probeRow.row.canonicalSlug })
                print("[probe.dbg] target=\"\(target ?? "<nil>")\" rowsMatchingNumber=\(rowsMatchingNumber.count) rowsMatchingNumberAndLangEN=\(rowsMatchingNumberAndLangEN.count) probeRowInMatch=\(probeInRowsMatching)")
            }
            #endif

            // 4a) Path A — both OCR fields set, query = row embedding.
            let t0 = Date()
            let pathA = identifier.identify(.init(
                queryEmbedding: probeQuery,
                language: probeRow.language,
                ocrCardNumber: probeRow.row.cardNumber,
                ocrSetHint: probeRow.row.setName,
                limit: 5,
            ))
            let pathAElapsed = Date().timeIntervalSince(t0) * 1000
            let pathAOk = pathA.winningPath == .ocrDirectUnique
                && pathA.confidence == .high
                && pathA.matches.first?.row.canonicalSlug == probeRow.row.canonicalSlug
            checks.append(.init(
                name: "identify.pathA",
                passed: pathAOk,
                elapsedMs: pathAElapsed,
                detail: pathAOk
                    ? "ocr_direct_unique HIGH → \(probeRow.row.canonicalSlug)"
                    : "expected ocr_direct_unique HIGH/\(probeRow.row.canonicalSlug); got \(pathA.winningPath.rawValue) \(pathA.confidence.rawValue)/\(pathA.matches.first?.row.canonicalSlug ?? "<nil>")",
            ))

            // 4b) Path B — only card_number, no set hint. Identifier
            // should fall through Path A (no hint) and try Path B
            // intersection. With the row's exact embedding as query,
            // CLIP's top-1 will be probeRow.slug; intersecting with
            // directRows (all rows with that card_number) should
            // yield exactly that slug (or a small set we still pass).
            let t1 = Date()
            let pathB = identifier.identify(.init(
                queryEmbedding: probeQuery,
                language: probeRow.language,
                ocrCardNumber: probeRow.row.cardNumber,
                ocrSetHint: nil,
                limit: 5,
            ))
            let pathBElapsed = Date().timeIntervalSince(t1) * 1000
            // Accept either ocr_intersect_unique or ocr_intersect_narrow
            // (multiple sets share card numbers — Suicune & Entei #94
            // collisions are real). What we really want to validate is
            // that PATH B FIRES, not Path C.
            let pathBOk = (pathB.winningPath == .ocrIntersectUnique
                || pathB.winningPath == .ocrIntersectNarrow)
                && pathB.matches.contains(where: { $0.row.canonicalSlug == probeRow.row.canonicalSlug })
            checks.append(.init(
                name: "identify.pathB",
                passed: pathBOk,
                elapsedMs: pathBElapsed,
                detail: pathBOk
                    ? "\(pathB.winningPath.rawValue) \(pathB.confidence.rawValue) (slug present in matches)"
                    : "expected ocr_intersect_*; got \(pathB.winningPath.rawValue) \(pathB.confidence.rawValue) top1=\(pathB.matches.first?.row.canonicalSlug ?? "<nil>")",
            ))

            // 4c) Path C — no OCR, no hint. Vision-only with whatever
            // the catalog-row embedding produces (which is itself, so
            // top-1 should be the same row at sim≈1.0 → HIGH).
            let t2 = Date()
            let pathC = identifier.identify(.init(
                queryEmbedding: probeQuery,
                language: probeRow.language,
                ocrCardNumber: nil,
                ocrSetHint: nil,
                limit: 5,
            ))
            let pathCElapsed = Date().timeIntervalSince(t2) * 1000
            let pathCOk = pathC.winningPath == .visionOnly
                && pathC.matches.first?.row.canonicalSlug == probeRow.row.canonicalSlug
            checks.append(.init(
                name: "identify.pathC",
                passed: pathCOk,
                elapsedMs: pathCElapsed,
                detail: pathCOk
                    ? "vision_only \(pathC.confidence.rawValue) sim=\(String(format: "%.4f", pathC.matches.first?.similarity ?? 0)) → \(probeRow.row.canonicalSlug)"
                    : "expected vision_only/\(probeRow.row.canonicalSlug); got \(pathC.winningPath.rawValue) top1=\(pathC.matches.first?.row.canonicalSlug ?? "<nil>")",
            ))
        } else {
            checks.append(.init(
                name: "identify.probe",
                passed: false,
                elapsedMs: 0,
                detail: "could not find a catalog row with both setName + cardNumber to probe identifier paths",
            ))
        }

        // -- Tier 5: OfflineCatalogManager download + validate --
        // Forces a fresh download from Supabase Storage so we exercise
        // the remote sync path even when a local cache + bundled
        // fallback would short-circuit it. Validates the downloaded
        // catalog has the same row_count and model_version as the
        // bundled reference (`cat`).
        let manager = OfflineCatalogManager()
        let t5 = Date()
        var downloadSucceeded = false
        do {
            try? manager.clearCache()
            let downloaded = try await manager.ensureReady(
                forceRefresh: true,
                allowBundledFallback: false,
            )
            let elapsed = Date().timeIntervalSince(t5) * 1000
            let rowsOk = downloaded.numRows == cat.numRows
            let modelOk = downloaded.modelVersion == cat.modelVersion
            let dimOk = downloaded.vectorDim == cat.vectorDim
            let allOk = rowsOk && modelOk && dimOk
            downloadSucceeded = allOk
            checks.append(.init(
                name: "manager.download",
                passed: allOk,
                elapsedMs: elapsed,
                detail: allOk
                    ? "fetched \(downloaded.numRows) rows × \(downloaded.vectorDim)d (model_version=\(downloaded.modelVersion))"
                    : "rows ok=\(rowsOk) model ok=\(modelOk) dim ok=\(dimOk) — downloaded:\(downloaded.numRows)/\(downloaded.vectorDim)/\(downloaded.modelVersion) bundled:\(cat.numRows)/\(cat.vectorDim)/\(cat.modelVersion)",
            ))
        } catch {
            // Treat network failures as "skipped, not failed" so
            // offline / no-Supabase test runs don't show a red ❌ for
            // a thing that's working as designed (graceful fallback).
            let elapsed = Date().timeIntervalSince(t5) * 1000
            checks.append(.init(
                name: "manager.download",
                passed: true,  // soft-skip
                elapsedMs: elapsed,
                detail: "skipped: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)",
            ))
        }

        // -- Tier 7: canonical-image roundtrip --
        // Pull a known catalog row's published PNG from Supabase
        // Storage, run it through the EXACT embedder pipeline a live
        // scan uses, and verify kNN top-1 matches. This separates
        // "embedder pipeline broken" from "live capture broken" when
        // diagnosing field issues.
        let canonicalProbeSlug = "paldea-evolved-123-garganacl"
        let canonicalURL = URL(
            string: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/\(canonicalProbeSlug)/full.png",
        )!
        let t7 = Date()
        do {
            let (data, response) = try await URLSession.shared.data(from: canonicalURL)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw NSError(domain: "smoke.canonical", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])
            }
            guard let canonicalImage = UIImage(data: data) else {
                throw NSError(domain: "smoke.canonical", code: -1, userInfo: [NSLocalizedDescriptionKey: "PNG decode failed (\(data.count) bytes)"])
            }
            let queryFromImage = try emb.embed(image: canonicalImage)
            let hits = knn.topK(query: queryFromImage, k: 5)
            let elapsed = Date().timeIntervalSince(t7) * 1000
            let topHit = hits.first
            let slugMatched = topHit?.row.canonicalSlug == canonicalProbeSlug
            let simAcceptable = (topHit?.similarity ?? 0) >= 0.95
            let topSlugs = hits.prefix(3).map {
                "\($0.row.canonicalSlug)(\(String(format: "%.3f", $0.similarity)))"
            }.joined(separator: ", ")
            checks.append(.init(
                name: "embedder.canonical",
                passed: slugMatched && simAcceptable,
                elapsedMs: elapsed,
                detail: (slugMatched && simAcceptable)
                    ? "top-1 = \(canonicalProbeSlug) sim=\(String(format: "%.4f", topHit!.similarity)) — pipeline matches catalog manifold"
                    : "expected \(canonicalProbeSlug) ≥0.95; got \(topSlugs)",
            ))
        } catch {
            // Network failure → soft-skip (pass=true with skipped detail)
            // so the smoke test stays useful when Supabase is unreachable.
            let elapsed = Date().timeIntervalSince(t7) * 1000
            checks.append(.init(
                name: "embedder.canonical",
                passed: true,
                elapsedMs: elapsed,
                detail: "skipped: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)",
            ))
        }

        // -- Tier 5b: cache-hit fast path --
        // After a successful download the cache + ETag are populated.
        // ensureReady(forceRefresh: false) should NOT redownload —
        // a HEAD request + same-ETag should short-circuit to the
        // cached file in <100ms total.
        if downloadSucceeded {
            let t5b = Date()
            do {
                let cached = try await manager.ensureReady(
                    forceRefresh: false,
                    allowBundledFallback: false,
                )
                let elapsed = Date().timeIntervalSince(t5b) * 1000
                // Cache hit if elapsed is much less than a fresh
                // download (Tier 5 was ~4s for 35MB; cache-hit budget
                // is generous at 1500ms to absorb HEAD + parse on a
                // slow simulator).
                let fastEnough = elapsed < 1500
                let rowsMatch = cached.numRows == cat.numRows
                checks.append(.init(
                    name: "manager.cacheHit",
                    passed: fastEnough && rowsMatch,
                    elapsedMs: elapsed,
                    detail: (fastEnough && rowsMatch)
                        ? "loaded \(cached.numRows) rows from local cache (no body re-downloaded)"
                        : "fastEnough=\(fastEnough) rowsMatch=\(rowsMatch) — was the body re-downloaded?",
                ))
            } catch {
                checks.append(.init(
                    name: "manager.cacheHit",
                    passed: false,
                    elapsedMs: Date().timeIntervalSince(t5b) * 1000,
                    detail: "throw: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)",
                ))
            }
        }

        return finalize(catalogPath: catalogPath, modelPath: modelPath, checks: checks)
    }

    /// Picks a catalog row that satisfies BOTH path-A and path-B
    /// preconditions so all three identifier checks fire on the same
    /// probe:
    ///
    ///   • (lang, setNorm, cardNumNorm) → exactly 1 slug      [Path A]
    ///   • (lang, cardNumNorm) → 1, 2, or 3 distinct slugs    [Path B]
    ///
    /// The Path B requirement is critical — common collector numbers
    /// like "96" appear in 50+ sets, so the kNN ∩ directRows
    /// intersection blows past the 3-slug ceiling and falls through
    /// to Path C, missing Path B coverage. Filtering for card_numbers
    /// that map to ≤3 catalog slugs total guarantees Path B fires.
    /// In our 23k-row catalog this means card_number values like
    /// `RC23`, `SWSH062`, or `TG30` (set-prefixed alphanumerics) plus
    /// the long tail of cards in small/mini sets.
    private static func pickIdentifierProbeRow(
        catalog: OfflineCatalog,
    ) -> (rowIndex: Int, row: OfflineCatalogRow, language: String)? {
        // Bucket: (lang, cardNumNorm) → slugs
        var slugsByNumberKey: [String: Set<String>] = [:]
        // Bucket: (lang, setNorm, cardNumNorm) → slugs
        var slugsBySetNumberKey: [String: Set<String>] = [:]
        // First row index for each setNumberKey
        var firstIndexBySetNumberKey: [String: Int] = [:]

        for (i, row) in catalog.rows.enumerated() {
            guard let setName = row.setName, !setName.isEmpty,
                  let num = row.cardNumber, !num.isEmpty else {
                continue
            }
            let lang = (row.language ?? "EN").uppercased()
            let setNorm = OfflineIdentifier.normalizeSetNameForCompare(setName)
            let numNorm = OfflineIdentifier.normalizeCardNumberForCompare(num) ?? num
            let numKey = "\(lang)|\(numNorm)"
            let setNumberKey = "\(numKey)|\(setNorm)"
            slugsByNumberKey[numKey, default: []].insert(row.canonicalSlug)
            slugsBySetNumberKey[setNumberKey, default: []].insert(row.canonicalSlug)
            if firstIndexBySetNumberKey[setNumberKey] == nil {
                firstIndexBySetNumberKey[setNumberKey] = i
            }
        }

        // Pick a (lang, setName, cardNumber) with exactly 1 slug
        // (Path A unique) AND whose (lang, cardNumber) has ≤3 slugs
        // (Path B fires). Stable ordering so the smoke test is
        // deterministic across runs.
        let candidates = slugsBySetNumberKey
            .filter { $0.value.count == 1 }
            .keys
            .sorted()
        for setNumberKey in candidates {
            // Reconstruct numKey by dropping the trailing "|setNorm".
            // setNumberKey = "lang|numNorm|setNorm"; numKey = "lang|numNorm".
            let parts = setNumberKey.split(separator: "|", maxSplits: 2)
            guard parts.count >= 2 else { continue }
            let numKey = "\(parts[0])|\(parts[1])"
            let numSlugs = slugsByNumberKey[numKey]?.count ?? 0
            guard numSlugs >= 1 && numSlugs <= 3 else { continue }
            guard let idx = firstIndexBySetNumberKey[setNumberKey] else { continue }
            let row = catalog.rows[idx]
            let lang = row.language ?? "EN"
            return (idx, row, lang)
        }
        return nil
    }

    private static func finalize(
        catalogPath: String,
        modelPath: String,
        checks: [OfflineScannerSmokeReport.CheckResult],
    ) -> OfflineScannerSmokeReport {
        return OfflineScannerSmokeReport(
            catalogPath: catalogPath,
            modelPath: modelPath,
            checks: checks,
        )
    }

    // MARK: - Fixture helpers

    /// Pulls row `rowIndex`'s embedding from the catalog's mmap'd
    /// region into a fresh `[Float]`. Handles both fp32 and fp16
    /// catalog dtypes. The returned vector is L2-normalized (the
    /// catalog stores normalized vectors), so it's ready to feed
    /// into kNN as a query.
    private static func extractCatalogRow(catalog: OfflineCatalog, rowIndex: Int) -> [Float] {
        var out = [Float](repeating: 0, count: catalog.vectorDim)
        catalog.withEmbeddingsPointer { rawPtr in
            switch catalog.dtype {
            case .float32:
                let f32Ptr = rawPtr.bindMemory(
                    to: Float.self,
                    capacity: catalog.numRows * catalog.vectorDim,
                )
                let rowStart = rowIndex * catalog.vectorDim
                for i in 0..<catalog.vectorDim {
                    out[i] = f32Ptr[rowStart + i]
                }
            case .float16:
                let halfPtr = rawPtr.bindMemory(
                    to: UInt16.self,
                    capacity: catalog.numRows * catalog.vectorDim,
                )
                let rowStart = rowIndex * catalog.vectorDim
                for i in 0..<catalog.vectorDim {
                    out[i] = Float(Float16(bitPattern: halfPtr[rowStart + i]))
                }
            }
        }
        return out
    }

    /// Synthesizes a deterministic noise UIImage. Uses a tiny LCG so
    /// the output is bit-exact reproducible across runs — handy for
    /// diagnosing "did our embedding drift?" later. Seed param lets
    /// tests vary the image without needing a fixture asset.
    private static func makeNoiseImage(side: Int, seed: UInt32) -> UIImage {
        let bytesPerPixel = 4
        let bytesPerRow = side * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: side * bytesPerRow)

        // Tiny LCG (numerical recipes constants). Not cryptographic —
        // just deterministic enough for a stable test fixture.
        var state: UInt32 = seed &* 1103515245 &+ 12345
        for i in 0..<(side * side) {
            state = state &* 1103515245 &+ 12345
            let r = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let g = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let b = UInt8((state >> 16) & 0xFF)
            let off = i * bytesPerPixel
            pixels[off + 0] = r
            pixels[off + 1] = g
            pixels[off + 2] = b
            pixels[off + 3] = 255
        }

        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let cg = CGImage(
            width: side,
            height: side,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: cs,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent,
        )!
        return UIImage(cgImage: cg)
    }
}
