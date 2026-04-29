import UIKit
@preconcurrency import Vision

/// On-device OCR for the scanner. Pulls both the collector number
/// (X/Y in the bottom corner) and a set-name hint from any other
/// printed text in the captured frame. Both signals are forwarded to
/// `/api/scan/identify` as filters layered on top of CLIP's kNN.
/// Free — Apple ships `VNRecognizeTextRequest`.
///
/// Why both: card_number alone disambiguates same-art-different-print
/// pairs (V vs VMAX vs ex of the same character). But card_number can
/// COLLIDE across sets — Umbreon V #94 (Evolving Skies) and
/// Suicune & Entei LEGEND #94 (HS Unleashed) are entirely different
/// cards that share the printed number. The set-name hint resolves
/// those: "Evolving Skies" → Umbreon V wins. Real-device 2026-04-29
/// hit this collision and got auto-navigated to the wrong card before
/// the trust-killer fix in 5f2df4f.
///
/// `extractCardIdentifiers` is the new entry point that returns both
/// fields in one Vision pass. `extractCollectorNumber` stays for
/// callers that only need the number (used by the legacy reranker).
enum OCRService {
    /// Regex picks up "177/217" or "177 / 217" with optional surrounding
    /// whitespace. First capture = card number, second = set size.
    /// We return the first capture only since set size isn't needed.
    private static let collectorPattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: #"\b(\d{1,3})\s*/\s*(\d{1,3})\b"#,
            options: []
        )
    }()

    /// Combined extractor: runs ONE Vision pass and returns both the
    /// collector number (digits before the "/" in "70/197" style
    /// printings) AND a free-text set-name hint (the longest
    /// recognized line that looks like text not numbers — usually
    /// the printed set name like "Phantasmal Flames" or
    /// "Pokémon GO"). Both fields are independently nullable;
    /// callers can use whichever the OCR successfully extracted.
    ///
    /// Non-throwing by design. OCR is a boost, not a gate — any
    /// failure should fall through to vanilla CLIP ranking, not
    /// block the scan.
    static func extractCardIdentifiers(
        from image: UIImage
    ) async -> (cardNumber: String?, setHint: String?) {
        guard let cgImage = image.cgImage else { return (nil, nil) }

        return await withCheckedContinuation { (continuation: CheckedContinuation<(String?, String?), Never>) in
            let request = VNRecognizeTextRequest { request, _ in
                guard
                    let results = request.results as? [VNRecognizedTextObservation]
                else {
                    continuation.resume(returning: (nil, nil))
                    return
                }

                let lines: [String] = results.compactMap { obs in
                    obs.topCandidates(1).first?.string
                }

                let cardNumber = lines.lazy
                    .compactMap { firstCollectorNumber(in: $0) }
                    .first

                let setHint = pickSetHint(from: lines)

                continuation.resume(returning: (cardNumber, setHint))
            }

            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.usesLanguageCorrection = false

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])

            do {
                try handler.perform([request])
            } catch {
                continuation.resume(returning: (nil, nil))
            }
        }
    }

    /// Legacy single-field extractor. Kept for the existing
    /// `ScanMatchReranker` call site which only needs the number.
    /// New code should call `extractCardIdentifiers` to also get the
    /// set hint in one Vision pass.
    static func extractCollectorNumber(from image: UIImage) async -> String? {
        await extractCardIdentifiers(from: image).cardNumber
    }

    /// Pick the most set-name-looking line from a Vision OCR pass.
    /// Heuristic: take the longest line that's mostly letters (≥3
    /// letter characters, ≤30 chars total, contains a space OR is
    /// at least 5 letters long). Filters out lines that are just
    /// numbers, very short codes, or pure flavor text.
    static func pickSetHint(from lines: [String]) -> String? {
        let candidates: [(String, Int)] = lines.compactMap { raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count >= 3, trimmed.count <= 40 else { return nil }

            let letters = trimmed.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
            let digits = trimmed.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }.count
            // Reject if mostly digits (collector numbers, prices, energy
            // costs) or if it's a tiny code.
            guard letters >= 3, letters > digits else { return nil }
            // Reject if the line looks like a fraction/rule text.
            if trimmed.contains("/") && digits > 2 { return nil }

            // Score: longer = more likely a real set name (vs a
            // 3-letter HP value or "EX"). Multi-word lines also
            // preferred — set names are usually 2+ words.
            let wordCount = trimmed.split(separator: " ").count
            let score = letters * 2 + (wordCount > 1 ? 5 : 0)
            return (trimmed, score)
        }

        return candidates.max(by: { $0.1 < $1.1 })?.0
    }

    /// Scans a single OCR'd line for the first "X/Y" pattern, returns
    /// the normalized X. Exposed static + internal so tests can poke
    /// the extractor without firing Vision.
    static func firstCollectorNumber(in text: String) -> String? {
        let ns = text as NSString
        let match = collectorPattern.firstMatch(
            in: text,
            options: [],
            range: NSRange(location: 0, length: ns.length)
        )
        guard let match, match.numberOfRanges >= 2 else { return nil }
        let numberRange = match.range(at: 1)
        guard numberRange.location != NSNotFound else { return nil }

        let raw = ns.substring(with: numberRange)
        return normalizeCardNumber(raw)
    }

    /// Strips leading zeros so an OCR read of "007" matches an index
    /// card_number of "7". Preserves "0" itself if that somehow shows
    /// up.
    static func normalizeCardNumber(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        let stripped = trimmed.drop { $0 == "0" }
        return stripped.isEmpty ? "0" : String(stripped)
    }
}

// MARK: - Match reranking by OCR

/// Given the raw identify response and an optional OCR'd collector
/// number, produce a reordered match list + possibly-upgraded
/// confidence. The intended call site is ScannerHost.runIdentify
/// right after both the CLIP and OCR pipelines have finished.
///
/// Rules:
///   1. If OCR returned nothing, pass the response through unchanged.
///   2. If any of the top matches have `card_number == ocr_number`,
///      promote the first such match to position 1 and upgrade
///      confidence to "high" — OCR+CLIP agreement is a strong
///      signal that beats CLIP-alone thresholds.
///   3. If OCR got a number but no match has it, trust CLIP's
///      ordering (the OCR read may be wrong, or the correct card
///      may be outside top-5). Don't penalize CLIP on an OCR miss.
enum ScanMatchReranker {
    struct Result {
        let matches: [ScanMatch]
        let confidence: String
        let ocrNumberUsed: String?
    }

    static func rerank(
        matches: [ScanMatch],
        originalConfidence: String,
        ocrCardNumber: String?
    ) -> Result {
        guard let ocrNumber = ocrCardNumber, !matches.isEmpty else {
            return Result(matches: matches, confidence: originalConfidence, ocrNumberUsed: nil)
        }

        let normalizedOcr = OCRService.normalizeCardNumber(ocrNumber)

        // Find matches whose normalized card_number equals the OCR'd number.
        let firstMatchIndex = matches.firstIndex { match in
            guard let raw = match.cardNumber else { return false }
            return OCRService.normalizeCardNumber(raw) == normalizedOcr
        }

        guard let promoteIndex = firstMatchIndex else {
            // OCR found something but nothing in the top-K lines up —
            // leave CLIP's ordering alone.
            return Result(matches: matches, confidence: originalConfidence, ocrNumberUsed: ocrNumber)
        }

        if promoteIndex == 0 {
            // CLIP's top-1 already agrees with OCR. Upgrade confidence
            // to "high" regardless of what CLIP originally said — two
            // independent signals agreeing is the strongest possible
            // evidence we have at the API layer.
            return Result(matches: matches, confidence: "high", ocrNumberUsed: ocrNumber)
        }

        // Promote the matching card to position 1, preserving the
        // relative order of everything else.
        var reordered: [ScanMatch] = []
        reordered.append(matches[promoteIndex])
        for (index, match) in matches.enumerated() where index != promoteIndex {
            reordered.append(match)
        }

        return Result(matches: reordered, confidence: "high", ocrNumberUsed: ocrNumber)
    }
}
