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

    /// Combined extractor: returns the FIRST card-number candidate +
    /// set-name hint. Convenience wrapper around
    /// `extractCardIdentifiersMulti`; new code that can handle multi-
    /// candidate OCR (e.g. the offline scanner's Path B trial loop)
    /// should call the multi version directly.
    ///
    /// Non-throwing by design. OCR is a boost, not a gate — any
    /// failure should fall through to vanilla CLIP ranking, not
    /// block the scan.
    static func extractCardIdentifiers(
        from image: UIImage
    ) async -> (cardNumber: String?, setHint: String?) {
        let multi = await extractCardIdentifiersMulti(from: image)
        return (multi.cardNumbers.first, multi.setHint)
    }

    /// Multi-candidate OCR. Two innovations over `extractCardIdentifiers`:
    ///
    /// 1. **Vision beam search via `topCandidates(N)`.** Single-candidate
    ///    mode discards N-1 alternate transcriptions per text region.
    ///    Under glare or stylized fonts, Vision's candidate-1 might be
    ///    "158/159" while candidate-2 reads "058/159" — only the second
    ///    matches a real catalog row. This API exposes both.
    ///
    /// 2. **Two-pass recognition** — full image AND a 2× upscaled crop
    ///    of the bottom 18% of the card. Modern Pokemon TCG cards
    ///    print the collector number in tiny text at the bottom strip
    ///    (~12-15px tall in our captures); upscaling 3× pushes it to
    ///    ~36-45px which is solidly in Vision's accurate-mode comfort
    ///    zone. The two passes run concurrently via `async let`.
    ///
    /// Returned `cardNumbers` is deduped, ordered with full-pass
    /// candidates first (typically more accurate when text is large)
    /// then strip-pass candidates (rescue for tiny text). Callers
    /// should try each in turn against Path A/B and accept the first
    /// one that yields a unique match.
    ///
    /// Real-device 2026-05-02: Journey Together Mr. Mime returned
    /// `cardNumber=158` from candidate-1 of the full pass; Vision's
    /// candidate-2 had `058`, which the multi version surfaces.
    /// Drampa Journey Together returned `["30"]` from "1 30/159"
    /// kerning — the space-split recovery in `collectorNumberCandidates`
    /// also surfaces "130" as an additional candidate for this case.
    static func extractCardIdentifiersMulti(
        from image: UIImage,
        maxCandidatesPerObservation: Int = 3,
    ) async -> (cardNumbers: [String], setHint: String?) {
        async let fullPass = recognizeText(
            in: image,
            maxCandidatesPerObservation: maxCandidatesPerObservation,
        )
        async let stripPass: ([String], String?) = {
            // Bottom 18% comfortably contains the collector number on
            // every modern Pokemon TCG layout I've checked. 3× upscale
            // takes the ~12-15px digits to ~36-45px — well within
            // Vision's accurate-mode sweet spot.
            guard let strip = upscaledBottomStrip(image, ratio: 0.18, scale: 3.0) else {
                return ([], nil)
            }
            return await recognizeText(
                in: strip,
                maxCandidatesPerObservation: maxCandidatesPerObservation,
            )
        }()

        let (full, strip) = await (fullPass, stripPass)

        // Dedupe-merge: full-pass first (large text already in Vision's
        // sweet spot), strip pass as rescue for tiny text.
        var seen = Set<String>()
        var merged: [String] = []
        for n in full.0 + strip.0 where seen.insert(n).inserted {
            merged.append(n)
        }
        // Set hint: full-pass only. The bottom strip rarely contains
        // a usable set name and is dominated by collector number,
        // copyright, and set code — none of which `pickSetHint` would
        // accept anyway.
        return (merged, full.1)
    }

    /// Inner Vision pass on a single image. Pulled out of
    /// `extractCardIdentifiersMulti` so the full + strip passes can
    /// run concurrently via `async let`.
    private static func recognizeText(
        in image: UIImage,
        maxCandidatesPerObservation: Int,
    ) async -> ([String], String?) {
        guard let cgImage = image.cgImage else { return ([], nil) }

        return await withCheckedContinuation { (continuation: CheckedContinuation<([String], String?), Never>) in
            let request = VNRecognizeTextRequest { request, _ in
                guard
                    let results = request.results as? [VNRecognizedTextObservation]
                else {
                    continuation.resume(returning: ([], nil))
                    return
                }

                let topLines: [String] = results.compactMap { obs in
                    obs.topCandidates(1).first?.string
                }
                let setHint = pickSetHint(from: topLines)

                var seenCardNumbers = Set<String>()
                var cardNumbers: [String] = []
                for obs in results {
                    let candidates = obs.topCandidates(maxCandidatesPerObservation)
                    for candidate in candidates {
                        for n in collectorNumberCandidates(in: candidate.string) {
                            if seenCardNumbers.insert(n).inserted {
                                cardNumbers.append(n)
                            }
                        }
                    }
                }

                continuation.resume(returning: (cardNumbers, setHint))
            }

            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.usesLanguageCorrection = false
            // Pin to revision 3 (iOS 16+). Default already picks the
            // latest available, but explicit pin removes any future-
            // OS ambiguity. V3 is meaningfully better than V1/V2 on
            // tiny / stylized text.
            if #available(iOS 16.0, *) {
                request.revision = VNRecognizeTextRequestRevision3
            }

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])

            do {
                try handler.perform([request])
            } catch {
                continuation.resume(returning: ([], nil))
            }
        }
    }

    /// Crops the bottom `ratio` of `image` and renders at `scale`×
    /// resolution via bicubic interpolation. Used by the multi-pass
    /// OCR flow to give Vision a much larger pixel canvas for the
    /// collector-number text region.
    static func upscaledBottomStrip(
        _ image: UIImage,
        ratio: CGFloat,
        scale: CGFloat,
    ) -> UIImage? {
        guard image.size.width > 0, image.size.height > 0,
              ratio > 0, ratio <= 1, scale >= 1 else {
            return nil
        }
        let stripHeight = image.size.height * ratio
        let outputSize = CGSize(
            width: image.size.width * scale,
            height: stripHeight * scale,
        )
        let format = UIGraphicsImageRendererFormat.default()
        // Output size already includes scale; don't double-bake screen scale.
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
        return renderer.image { ctx in
            ctx.cgContext.interpolationQuality = .high
            // Draw the FULL image at scale× into a context that's only
            // stripHeight × scale tall — shift up so the bottom strip
            // lands in the visible area.
            let drawSize = CGSize(
                width: image.size.width * scale,
                height: image.size.height * scale,
            )
            let drawRect = CGRect(
                x: 0,
                y: -(drawSize.height - outputSize.height),
                width: drawSize.width,
                height: drawSize.height,
            )
            image.draw(in: drawRect)
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
    ///
    /// Iteration history:
    ///   v1 (Day 1): "longest plausible letter-heavy line." Caused
    ///   real-device session 2 (2026-04-30) to return flavor text
    ///   like "evolves from antique dome fossil" or artist credits
    ///   like "Illus. Anesoki Dynamic" as the set hint, breaking
    ///   server-side Path A and triggering one HIGH-confidence-WRONG
    ///   false-positive when "fossil" matched the canonical "Fossil"
    ///   set name.
    ///
    ///   v2 (Day 3.5): rejects lines that look like flavor text or
    ///   metadata. The cleanest signal that a line ISN'T a set name
    ///   on a Pokémon card is one of:
    ///     - Starts with a metadata token: "Illus.", "©", "(C)",
    ///       "NO.", "HP", "Stage", "Basic", "Evolves" — these prefix
    ///       species classification, copyright lines, attack costs,
    ///       and evolution lines. None are set names.
    ///     - Ends with a period (sentence-cased flavor text — set
    ///       names don't end with periods).
    ///     - Contains a stop word that strongly signals prose ("is",
    ///       "the", "a", "from", "of", "this", "its", "by").
    ///
    /// Modern Pokémon cards rarely print the SET NAME on the front
    /// at all (just a small set CODE like "AR" or "PRE"). So this
    /// function returning nil is the COMMON case. That's fine —
    /// nil set_hint lets server-side Path B activate (the middle
    /// layer), which is strictly better than Path A firing on a
    /// false hint.
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

            // Reject metadata prefixes — these are species lines,
            // copyright, attack labels, evolution lines, never set
            // names. Case-insensitive prefix match.
            let lowered = trimmed.lowercased()
            let metadataPrefixes = [
                "illus.", "illus ", "©", "(c)", "c20", "©20",
                "no.", "no ", "hp", "stage", "basic ", "basic\t",
                "evolves ", "weakness", "resistance", "retreat",
                "ability", "pokémon power",
            ]
            if metadataPrefixes.contains(where: { lowered.hasPrefix($0) }) {
                return nil
            }
            // Reject sentence-cased flavor text — ends with period.
            if trimmed.hasSuffix(".") { return nil }
            // Reject prose stop words. Set names don't contain
            // articles or prepositions ("the", "a", "of", "from").
            let proseStopWords: Set<String> = [
                "is", "the", "a", "from", "of", "this", "its", "by",
                "to", "with", "and", "but", "or", "for", "as",
                "have", "has", "had", "be", "been",
            ]
            let words = lowered.split(separator: " ").map(String.init)
            if words.contains(where: { proseStopWords.contains($0) }) {
                return nil
            }

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
    /// the normalized X. Legacy single-result extractor — new code
    /// should call `collectorNumberCandidates(in:)` to also pick up
    /// space-split readings like "1 30/159" → ["30", "130"].
    static func firstCollectorNumber(in text: String) -> String? {
        return collectorNumberCandidates(in: text).first
    }

    /// All plausible collector numbers in `text`. A single OCR'd line
    /// can produce multiple candidates:
    ///
    ///   - **Direct**: "058/159" → ["58"]
    ///   - **Space-split**: "1 30/159" → ["30", "130"]
    ///       Vision sometimes inserts a space between digits when
    ///       printing kerning is unusual, splitting "130/159" into
    ///       "1 30/159". Without recovery, Path B looks for #30 (no
    ///       Drampa with #30 exists) and fails. Real-device 2026-05-02:
    ///       Drampa Journey Together hit this exact pattern.
    ///   - **Multiple X/Y on one line** (rare): both reported.
    ///
    /// Plausibility filters:
    ///   - Y ∈ [5, 600]: every Pokemon set has ≥5 cards and ≤600 cards.
    ///     Filters attack damage notations like "30/3" and HP fractions.
    ///   - X ≤ Y: an "X of Y" cardinal can't exceed Y.
    static func collectorNumberCandidates(in text: String) -> [String] {
        var candidates: [String] = []
        var seen = Set<String>()
        let ns = text as NSString
        let allMatches = collectorPattern.matches(
            in: text,
            options: [],
            range: NSRange(location: 0, length: ns.length),
        )
        for match in allMatches {
            guard match.numberOfRanges >= 3 else { continue }
            let xRange = match.range(at: 1)
            let yRange = match.range(at: 2)
            guard xRange.location != NSNotFound, yRange.location != NSNotFound else { continue }
            let xStr = ns.substring(with: xRange)
            let yStr = ns.substring(with: yRange)
            guard let yInt = Int(yStr), yInt >= 5, yInt <= 600 else { continue }
            guard let xInt = Int(xStr), xInt <= yInt else { continue }
            let normalized = normalizeCardNumber(xStr)
            if seen.insert(normalized).inserted {
                candidates.append(normalized)
            }

            // Space-split recovery: look for 1-2 digits right before
            // X (within 3 chars). If found, propose the concatenated
            // value too. "1 30/159" → also try "130".
            let lookbackStart = max(0, xRange.location - 3)
            let lookbackLen = xRange.location - lookbackStart
            if lookbackLen > 0 {
                let pre = ns.substring(with: NSRange(location: lookbackStart, length: lookbackLen))
                let preTrim = pre.trimmingCharacters(in: .whitespacesAndNewlines)
                if !preTrim.isEmpty,
                   preTrim.count <= 2,
                   preTrim.allSatisfy({ $0.isNumber }),
                   let preInt = Int(preTrim),
                   preInt >= 1,
                   let combinedInt = Int("\(preTrim)\(xStr)"),
                   combinedInt <= yInt {
                    let combined = normalizeCardNumber("\(preTrim)\(xStr)")
                    if seen.insert(combined).inserted {
                        candidates.append(combined)
                    }
                }
            }
        }
        return candidates
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
