import UIKit
@preconcurrency import Vision

/// On-device OCR focused specifically on pulling the collector number
/// (the `X/Y` pair in a Pokemon card's bottom corner). Used as a
/// disambiguator layered on top of the CLIP identify response:
/// when CLIP narrows to the right character but wrong print
/// (e.g. Hop's Cramorant Ascended Heroes vs Journey Together — same
/// art, same character, different card_number), the corner number
/// uniquely resolves it. Free — Apple ships `VNRecognizeTextRequest`.
///
/// Intentionally narrow: we only care about the integer before the
/// "/" (the "card number within set"). We don't try to read card
/// names or set symbols here — those are noisier to extract
/// reliably and CLIP already handles semantic identity.
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

    /// Runs `VNRecognizeTextRequest` against the captured image and
    /// returns the first collector number it finds, if any. Normalized
    /// (leading zeros stripped) so downstream string-equality against
    /// `card_number` from the scan match works directly.
    ///
    /// Returns nil if:
    ///   - OCR finds no text
    ///   - No text matches the collector-number regex
    ///   - The image is invalid or Vision errors
    ///
    /// Non-throwing by design. OCR is a boost, not a gate — any
    /// failure should fall through to vanilla CLIP ranking, not
    /// block the scan.
    static func extractCollectorNumber(from image: UIImage) async -> String? {
        guard let cgImage = image.cgImage else { return nil }

        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let request = VNRecognizeTextRequest { request, _ in
                guard
                    let results = request.results as? [VNRecognizedTextObservation]
                else {
                    continuation.resume(returning: nil)
                    return
                }

                for observation in results {
                    guard let top = observation.topCandidates(1).first else { continue }
                    if let number = firstCollectorNumber(in: top.string) {
                        continuation.resume(returning: number)
                        return
                    }
                }
                continuation.resume(returning: nil)
            }

            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.usesLanguageCorrection = false  // numbers shouldn't be autocorrected

            // Orientation hint: the scan pipeline already crops + rotates
            // the card to roughly-upright before getting here (via
            // PopAlphaVisionEngine.croppedToCard), so we ask Vision to
            // treat the pixels as-is. If that assumption ever breaks,
            // Vision will still succeed because its text detector is
            // rotation-robust — it might just take a few ms longer.
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])

            do {
                try handler.perform([request])
            } catch {
                continuation.resume(returning: nil)
            }
        }
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
