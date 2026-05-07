import OSLog
import UIKit
@preconcurrency import Vision

private let ocrLogger = Logger(subsystem: "ai.popalpha.ios", category: "scan")

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
        from image: UIImage,
    ) async -> (cardNumber: String?, setHint: String?, detectedLanguage: ScanLanguage) {
        let multi = await extractCardIdentifiersMulti(from: image)
        // Drops pass2FallbackFired / spatialFilterRejectedCount —
        // legacy single-result API. New code that needs telemetry
        // should call extractCardIdentifiersMulti directly.
        return (multi.cardNumbers.first, multi.setHint, multi.detectedLanguage)
    }

    /// Multi-frame OCR consensus. Aggregates `extractCardIdentifiersMulti`
    /// results across N frames captured ~200ms apart from the tap path,
    /// votes on card_number candidates by frequency, and merges the rest.
    ///
    /// Why: a single video frame is fragile under glare / motion blur /
    /// partial occlusion / hand tremor. Running OCR on 3-5 frames over
    /// ~400ms gives Vision multiple shots at the card_number row under
    /// slightly different conditions — and the candidates that appear in
    /// 2+ frames are the trustworthy ones.
    ///
    /// Per-frame OCR runs CONCURRENTLY via `withTaskGroup` because each
    /// `extractCardIdentifiersMulti` call only does pure pixel work
    /// (Vision request + post-processing). No shared mutable state, so
    /// CPU parallelism is safe and meaningful (~5x faster than serial
    /// for 5 frames).
    ///
    /// Card_number ranking — votes first, then first-seen order as
    /// tiebreak. The orchestrator's `identifyMulti` tries each
    /// candidate in turn; voting puts the consensus answer first so the
    /// most-likely-correct read is what hits Path B intersection.
    ///
    /// Set hint — most-voted hint wins; ties broken by first-seen.
    /// Same logic as cardNumbers but separate counter.
    ///
    /// Language — any frame seeing CJK glyphs flips the result to JP.
    /// One frame catching JP is enough; CJK character class has no
    /// false-positive against Latin.
    ///
    /// Caller passes the same image type sequence as the single-frame
    /// path — typically the embedder-cropped frame, since on-real-device
    /// data showed Vision text recognition is dramatically better on
    /// the tight 0.85 center-crop than the full frame (commit 2026-05-05
    /// Path A baseline).
    static func extractCardIdentifiersMultiFrame(
        from frames: [UIImage],
        maxCandidatesPerObservation: Int = 3,
    ) async -> (
        cardNumbers: [String],
        setHint: String?,
        detectedLanguage: ScanLanguage,
        pass2FallbackFired: Bool,
        spatialFilterRejectedCount: Int
    ) {
        guard !frames.isEmpty else {
            return ([], nil, .en, false, 0)
        }
        if frames.count == 1 {
            // Degenerate case: identical to single-frame path. Skip the
            // aggregation overhead.
            return await extractCardIdentifiersMulti(
                from: frames[0],
                maxCandidatesPerObservation: maxCandidatesPerObservation,
            )
        }

        // Per-frame OCR in parallel. Each task index is preserved as the
        // first element so we can reconstruct first-seen order across
        // frames (TaskGroup completion order is non-deterministic).
        struct PerFrame: Sendable {
            let index: Int
            let cardNumbers: [String]
            let setHint: String?
            let detectedLanguage: ScanLanguage
            let pass2FallbackFired: Bool
            let spatialFilterRejectedCount: Int
        }
        let perFrame: [PerFrame] = await withTaskGroup(of: PerFrame.self) { group in
            for (i, frame) in frames.enumerated() {
                group.addTask {
                    let r = await extractCardIdentifiersMulti(
                        from: frame,
                        maxCandidatesPerObservation: maxCandidatesPerObservation,
                    )
                    return PerFrame(
                        index: i,
                        cardNumbers: r.cardNumbers,
                        setHint: r.setHint,
                        detectedLanguage: r.detectedLanguage,
                        pass2FallbackFired: r.pass2FallbackFired,
                        spatialFilterRejectedCount: r.spatialFilterRejectedCount,
                    )
                }
            }
            var results: [PerFrame] = []
            for await r in group { results.append(r) }
            return results.sorted { $0.index < $1.index }
        }

        var cardVotes: [String: Int] = [:]
        var cardFirstSeen: [String: Int] = [:]
        var hintVotes: [String: Int] = [:]
        var hintFirstSeen: [String: Int] = [:]
        var sawJP = false
        var anyPass2Fired = false
        var spatialRejectedSum = 0

        for result in perFrame {
            for n in result.cardNumbers {
                cardVotes[n, default: 0] += 1
                if cardFirstSeen[n] == nil {
                    cardFirstSeen[n] = result.index
                }
            }
            if let h = result.setHint {
                hintVotes[h, default: 0] += 1
                if hintFirstSeen[h] == nil {
                    hintFirstSeen[h] = result.index
                }
            }
            if result.detectedLanguage == .jp {
                sawJP = true
            }
            if result.pass2FallbackFired {
                anyPass2Fired = true
            }
            spatialRejectedSum += result.spatialFilterRejectedCount
        }

        let votedCardNumbers = cardVotes.keys.sorted { a, b in
            let va = cardVotes[a] ?? 0
            let vb = cardVotes[b] ?? 0
            if va != vb { return va > vb }
            let oa = cardFirstSeen[a] ?? Int.max
            let ob = cardFirstSeen[b] ?? Int.max
            return oa < ob
        }
        let bestHint = hintVotes.keys.sorted { a, b in
            let va = hintVotes[a] ?? 0
            let vb = hintVotes[b] ?? 0
            if va != vb { return va > vb }
            let oa = hintFirstSeen[a] ?? Int.max
            let ob = hintFirstSeen[b] ?? Int.max
            return oa < ob
        }.first

        #if DEBUG
        ocrLogger.debug(
            "ocr multiframe frames=\(perFrame.count) voted_card_numbers=\(votedCardNumbers, privacy: .public) hint=\(bestHint ?? "nil", privacy: .public) raw_votes=\(cardVotes.map { "\($0.key)x\($0.value)" }.joined(separator: ","), privacy: .public) pass2_fired_any=\(anyPass2Fired) spatial_rejected_sum=\(spatialRejectedSum)"
        )
        #endif

        return (
            cardNumbers: votedCardNumbers,
            setHint: bestHint,
            detectedLanguage: sawJP ? .jp : .en,
            pass2FallbackFired: anyPass2Fired,
            spatialFilterRejectedCount: spatialRejectedSum,
        )
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
    ) async -> (
        cardNumbers: [String],
        setHint: String?,
        detectedLanguage: ScanLanguage,
        pass2FallbackFired: Bool,
        spatialFilterRejectedCount: Int
    ) {
        // Run Vision OCR once on each region (full image + bottom strip).
        // Both passes run concurrently — embed and pixel-data work is
        // independent. The post-processing (filtering, multi-pass logic)
        // is pure and runs after both Vision calls return.
        async let fullObservations = runVisionTextRecognition(in: image)
        async let stripObservations: [VNRecognizedTextObservation] = {
            // Bottom 25% upscaled 3×. Bumped from 0.18 on 2026-05-07
            // (Tier 1.1 stage 2) — real-device evidence showed
            // hand-held captures often have the card_number row at
            // ~22-28% from the image bottom because the user's grip
            // leaves empty space below the card. The narrower 18%
            // strip missed those rows entirely. Diminishing returns
            // above 25% (admits more attack/rules text).
            //
            // The strip is independently fed to Vision, so even if
            // the full-pass spatial filter rejects the card_number,
            // the strip pass — which has no spatial filter — should
            // surface it.
            guard let strip = upscaledBottomStrip(image, ratio: 0.25, scale: 3.0) else {
                return []
            }
            return await runVisionTextRecognition(in: strip)
        }()
        let (fullObs, stripObs) = await (fullObservations, stripObservations)

        // Telemetry (Phase 0c): count slash-bearing observations the
        // spatial filter rejected before we even ran the regex/
        // plausibility filters. High counts indicate Mode 1 (loose
        // grip pushes card_number above 0.35) or Mode 2 (landscape
        // capture, card_number on side edge). Aggregated weekly via
        // scan_identify_events / PostHog this tells us whether
        // orientation/framing modes are 5% or 50% of real-device
        // pain.
        let spatialFilterRejectedCount = fullObs.filter { obs in
            obs.boundingBox.midY >= 0.35
        }.filter { obs in
            obs.topCandidates(maxCandidatesPerObservation).contains { $0.string.contains("/") }
        }.count

        // Pass 1 — strict spatial filter on the full image.
        //
        // The full-pass uses `restrictToBottomRegion=true` to defend
        // against the original mid-card "X/Y" false-positive case
        // (Pokemon TCG Classic Chansey scan, 2026-05-06: OCR picked
        // up "3/Y" from mid-card and misidentified the card as
        // Charizard). The strip-pass has no spatial filter — its
        // observations are already in the bottom region by construction.
        let pass1FullCardNumbers = extractCardNumbers(
            from: fullObs,
            maxCandidatesPerObservation: maxCandidatesPerObservation,
            restrictToBottomRegion: true,
        )
        let stripCardNumbers = extractCardNumbers(
            from: stripObs,
            maxCandidatesPerObservation: maxCandidatesPerObservation,
            restrictToBottomRegion: false,
        )

        var seen = Set<String>()
        var merged: [String] = []
        for n in pass1FullCardNumbers + stripCardNumbers where seen.insert(n).inserted {
            merged.append(n)
        }

        // Pass 2 — fallback when Pass 1 returns empty AND Vision saw
        // slash-bearing text outside the bottom region.
        //
        // Tier 1.1 stage 1 (2026-05-07): real-device evidence showed
        // the spatial filter was rejecting valid card_numbers in two
        // cases:
        //   - Mode 1 (hand-grip): card_number printed at midY ~0.20-
        //     0.30 because the card is loosely framed.
        //   - Mode 2 (landscape capture): card photographed sideways,
        //     card_number on a side edge of the frame.
        //
        // Both cases: the strip pass also fails (strip is bottom 25%
        // of an image where the card-bottom isn't at the image-bottom),
        // so merged is still empty. Pass 2 disables the spatial filter
        // on the full image and relies on the plausibility filter
        // (yInt ∈ [5, 600], xInt ∈ [1, 999]) alone to defend against
        // the original Chansey case. The plausibility filter parses
        // mid-card "X/Y" as y < 5 in most attack-damage cases; the
        // narrow remaining false-positive surface is acceptable
        // because admitting a wrong card_number falls through to
        // Path C (vision-only) harmlessly, while rejecting a real
        // card_number costs HIGH→medium confidence.
        //
        // Pass 2 only fires when merged is empty — successful Pass 1
        // results always win. No second Vision call: we re-process
        // the same observations with a different filter setting.
        var pass2FallbackFired = false
        if merged.isEmpty {
            let pass2FullCardNumbers = extractCardNumbers(
                from: fullObs,
                maxCandidatesPerObservation: maxCandidatesPerObservation,
                restrictToBottomRegion: false,
            )
            for n in pass2FullCardNumbers where seen.insert(n).inserted {
                merged.append(n)
            }
            // Pass-2 "fired" means we got here AND recovered ≥1
            // candidate. If pass-2 ran and still produced nothing,
            // that's Mode 6 (Vision saw no slash text at all) — distinct
            // from Mode 1/2 (saw it, spatial filter rejected, recovered
            // by pass-2). Telemetry distinguishes these.
            pass2FallbackFired = !merged.isEmpty
            #if DEBUG
            if pass2FallbackFired {
                ocrLogger.debug("ocr pass-2 fallback recovered \(merged.count) card_number(s) — \(merged.joined(separator: ","), privacy: .public)")
            }
            #endif
        }

        // Set hint and language detection use ALL observations
        // regardless of pass. setHint scans the upper region of the
        // full image (its own spatial filter, separate from
        // card_number's). Language detection runs against all OCR
        // text — any CJK character anywhere is the JP signal.
        let setHint = pickSetHint(from: fullObs)
        let fullLanguage = detectLanguage(from: fullObs)
        let stripLanguage = detectLanguage(from: stripObs)
        let detectedLanguage: ScanLanguage = (fullLanguage == .jp || stripLanguage == .jp) ? .jp : .en

        return (
            cardNumbers: merged,
            setHint: setHint,
            detectedLanguage: detectedLanguage,
            pass2FallbackFired: pass2FallbackFired,
            spatialFilterRejectedCount: spatialFilterRejectedCount
        )
    }

    /// Run Vision text recognition on a single image and return raw
    /// observations. Caller is responsible for post-processing —
    /// filtering by spatial region, extracting card_numbers via the
    /// collector pattern, picking set_hint, detecting language.
    ///
    /// Split out from the original `recognizeText` on 2026-05-07
    /// (Tier 1.1 stage 1) so the multi-pass fallback in
    /// `extractCardIdentifiersMulti` can re-process the same Vision
    /// observations with different filter settings — re-running
    /// Vision is the expensive part (~30-100ms), and the filter
    /// logic is pure data manipulation that should run multiple
    /// times for free.
    private static func runVisionTextRecognition(
        in image: UIImage,
    ) async -> [VNRecognizedTextObservation] {
        guard let cgImage = image.cgImage else { return [] }

        return await withCheckedContinuation { (continuation: CheckedContinuation<[VNRecognizedTextObservation], Never>) in
            let request = VNRecognizeTextRequest { request, _ in
                let results = (request.results as? [VNRecognizedTextObservation]) ?? []
                continuation.resume(returning: results)
            }

            request.recognitionLevel = .accurate
            // Always load both languages so language detection can run
            // against the recognized text — this is what makes
            // zero-tap JP recognition possible. Order matters: Vision
            // favors the FIRST listed language for ambiguous glyphs.
            // We put en-US first because:
            //   - The vast majority of scans are EN cards, and EN-first
            //     keeps Latin glyphs from being mis-recognized as
            //     visually-similar JP characters.
            //   - The CJK Unicode blocks have no visual overlap with
            //     Latin, so JP card names are still recognized
            //     correctly via the ja-JP fallback.
            //   - Card_number ("001/100"), HP, set code, and copyright
            //     print in Latin on both EN and JP cards — these are
            //     handled by the en-US recognizer regardless.
            //
            // Cost: Vision lazy-loads each language model on first use.
            // Cold-start adds ~50–100ms once per app session; subsequent
            // calls are cached.
            request.recognitionLanguages = ["en-US", "ja-JP"]
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
                continuation.resume(returning: [])
            }
        }
    }

    /// Pure post-processing: extract card_number candidates from a
    /// list of Vision observations, with optional spatial filtering.
    ///
    /// `restrictToBottomRegion`: when true, only consider observations
    /// whose `boundingBox.midY < 0.35`. Vision's coordinate space is
    /// bottom-left origin, so midY ≈ 0 is the bottom of the image and
    /// midY ≈ 1 is the top.
    ///
    /// 0.35 is the v3.5 threshold (relaxed from 0.22 on 2026-05-07).
    /// Real-device data showed hand-held scans had card_numbers
    /// printed at midY ~0.22-0.30. The Pokemon TCG Classic Chansey
    /// false-positive that drove the original 0.22 cutoff is still
    /// defended against by the plausibility filter in
    /// `collectorNumberCandidates` — mid-card "3/Y" patterns parse to
    /// y < 5 once the filter applies.
    ///
    /// When restricted-region returns no candidates, callers should
    /// retry with `restrictToBottomRegion: false` (the multi-pass
    /// fallback). Plausibility filter alone is the defense at that
    /// point.
    private static func extractCardNumbers(
        from observations: [VNRecognizedTextObservation],
        maxCandidatesPerObservation: Int,
        restrictToBottomRegion: Bool,
    ) -> [String] {
        let cardNumberObservations: [VNRecognizedTextObservation]
        if restrictToBottomRegion {
            cardNumberObservations = observations.filter { obs in
                obs.boundingBox.midY < 0.35
            }
        } else {
            cardNumberObservations = observations
        }

        var seenCardNumbers = Set<String>()
        var cardNumbers: [String] = []
        // Track which lines contained a "X/Y" shape but were
        // discarded — diagnostic for "OCR saw the number but the
        // regex/plausibility filter rejected it" vs "OCR didn't see
        // it at all". Keyed off the regex's slash pattern.
        var slashLinesSeen: [String] = []
        for obs in cardNumberObservations {
            let candidates = obs.topCandidates(maxCandidatesPerObservation)
            for candidate in candidates {
                if candidate.string.contains("/") {
                    slashLinesSeen.append(candidate.string)
                }
                for n in collectorNumberCandidates(in: candidate.string) {
                    if seenCardNumbers.insert(n).inserted {
                        cardNumbers.append(n)
                    }
                }
            }
        }
        #if DEBUG
        if cardNumbers.isEmpty && !slashLinesSeen.isEmpty {
            // OCR found "/"-bearing text but no candidate survived
            // the regex + plausibility filters. Surface it so we
            // can tell whether the secret-rare fix landed.
            let preview = slashLinesSeen.prefix(5).joined(separator: " | ")
            ocrLogger.debug("ocr slash-lines (no card_number extracted): \(preview, privacy: .public)")
        }
        if cardNumbers.isEmpty && restrictToBottomRegion {
            // Diagnostic: how much text did the spatial filter
            // reject? If we routinely see many observations with
            // `/`-bearing text in the upper region but none in the
            // bottom 35%, that's a signal the card is framed
            // unusually (Modes 1/2 in scanner-ocr-failure-modes.md).
            // The multi-pass fallback in extractCardIdentifiersMulti
            // catches these.
            let allSlashAcrossImage = observations.flatMap { obs in
                obs.topCandidates(maxCandidatesPerObservation).map { $0.string }
            }.filter { $0.contains("/") }
            if !allSlashAcrossImage.isEmpty {
                let preview = allSlashAcrossImage.prefix(5).joined(separator: " | ")
                ocrLogger.debug("ocr spatial filter rejected \(allSlashAcrossImage.count) slash-line(s) outside bottom region (pass-2 fallback may recover): \(preview, privacy: .public)")
            }
        }
        #endif

        return cardNumbers
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

    /// Detect the dominant language of the OCR result by inspecting
    /// the recognized text for CJK Unicode codepoints.
    ///
    /// JP Pokemon cards always print Hiragana (HP value gets the
    /// "HP" Latin marker but the card name is Hiragana/Katakana/
    /// Kanji), Katakana (most Pokemon names), or Kanji (some
    /// attack names, type labels) somewhere on the front. EN cards
    /// never contain those Unicode blocks. So a single CJK
    /// character anywhere in the OCR output is a definitive JP
    /// signal — the false-positive rate is essentially zero (Vision
    /// would have to misread a Latin glyph as a Japanese one,
    /// which doesn't happen for ja-JP / en-US recognizers in
    /// practice on text we'd be scanning).
    ///
    /// Empty observations (Vision returned no recognized text)
    /// default to .en — the offline scanner path is EN-optimized
    /// and the default card population is overwhelmingly EN.
    ///
    /// Codepoint ranges checked:
    ///   - U+3040–309F  Hiragana
    ///   - U+30A0–30FF  Katakana
    ///   - U+FF66–FF9F  Halfwidth Katakana
    ///   - U+4E00–9FFF  CJK Unified Ideographs (Kanji)
    ///   - U+3000–303F  CJK Symbols & Punctuation (covers full-width
    ///                  punctuation like 「」 that printed on JP cards)
    static func detectLanguage(from observations: [VNRecognizedTextObservation]) -> ScanLanguage {
        for obs in observations {
            guard let text = obs.topCandidates(1).first?.string else { continue }
            for scalar in text.unicodeScalars {
                let v = scalar.value
                if (v >= 0x3040 && v <= 0x309F)        // Hiragana
                    || (v >= 0x30A0 && v <= 0x30FF)    // Katakana
                    || (v >= 0xFF66 && v <= 0xFF9F)    // Halfwidth Katakana
                    || (v >= 0x4E00 && v <= 0x9FFF)    // Kanji
                    || (v >= 0x3000 && v <= 0x303F) {  // CJK punctuation
                    return .jp
                }
            }
        }
        return .en
    }

    /// Pick the most set-name-looking line from a Vision OCR pass,
    /// given the full observation list (so the scorer can use
    /// bounding-box positions in addition to text content).
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
    ///   v3 (Day 4 / 2026-05-06): adds spatial preference. Real-device
    ///   scan of a Pokemon TCG Classic Chansey returned the attack
    ///   line "Double-edge Chansey does 80" as the winning set
    ///   hint — long + letter-heavy beats every legitimate
    ///   candidate under v2's pure-content scoring. But set names
    ///   never print mid-card: they print mid/upper card under the
    ///   card name, while attack text and damage notation occupy
    ///   the middle, and collector # + © + set code dominate the
    ///   bottom 22%. v3:
    ///     - **Hard reject** observations whose `boundingBox.midY <
    ///       0.22` (Vision uses bottom-left-origin coords; midY ≈ 0
    ///       is the BOTTOM of the image). Kills "© 2025" / set code
    ///       false positives.
    ///     - **Soft prefer** observations with midY > 0.30 (upper
    ///       70%) via score boost. Real set names cluster around
    ///       midY 0.85-0.95 on modern cards.
    ///     - **Penalize 4+ word candidates** (real set names are
    ///       1-3 words; "Sword & Shield Crown Zenith" at 5 words
    ///       is the longest I could find and it would still survive
    ///       at score 0). Long lines are nearly always attack text
    ///       or rules text that slipped past the prefix/period/
    ///       stop-word filters.
    ///     - **Add "does", "deal", "deals", "dealt" to prose stop
    ///       words** to catch the "<Move> does 80" damage-notation
    ///       pattern explicitly.
    ///
    /// Modern Pokémon cards rarely print the SET NAME on the front
    /// at all (just a small set CODE like "AR" or "PRE"). So this
    /// function returning nil is the COMMON case. That's fine —
    /// nil set_hint lets server-side Path B activate (the middle
    /// layer), which is strictly better than Path A firing on a
    /// false hint.
    static func pickSetHint(from observations: [VNRecognizedTextObservation]) -> String? {
        // Pair top-candidate text with each observation's midY so the
        // scorer can apply both content filters and spatial
        // preference. Vision's coordinate space is bottom-left origin
        // (Apple docs): midY ≈ 0 = bottom of image, midY ≈ 1 = top.
        // Hard-reject the bottom 22% here so flavor / © / set-code
        // text never even reaches the content filters.
        let upperRegion: [(text: String, midY: CGFloat)] = observations.compactMap { obs in
            guard obs.boundingBox.midY >= 0.22 else { return nil }
            guard let text = obs.topCandidates(1).first?.string else { return nil }
            return (text, obs.boundingBox.midY)
        }

        let candidates: [(String, Int)] = upperRegion.compactMap { entry in
            let trimmed = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
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
            // articles, prepositions, or damage-notation verbs.
            // "does"/"deal"/"deals"/"dealt" catch the "<Move> does 80"
            // attack pattern explicitly.
            let proseStopWords: Set<String> = [
                "is", "the", "a", "from", "of", "this", "its", "by",
                "to", "with", "and", "but", "or", "for", "as",
                "have", "has", "had", "be", "been",
                "does", "deal", "deals", "dealt",
            ]
            let words = lowered.split(separator: " ").map(String.init)
            if words.contains(where: { proseStopWords.contains($0) }) {
                return nil
            }

            // Score:
            //   - Letters dominate (long letter-heavy lines beat short
            //     code-like lines).
            //   - 2+ word lines preferred — most set names are
            //     multi-word ("Surging Sparks", "Mega Evolution").
            //   - 4+ word lines penalized — at that length we're
            //     almost certainly looking at attack/rules text that
            //     slipped past the content filters. The penalty is
            //     mild enough that a 4-word legit set name still
            //     wins over a 1-word junk candidate.
            //   - Upper-region soft boost — bonus for midY > 0.30
            //     (above the bottom 30%). Real set names cluster
            //     near the top of the card.
            let wordCount = trimmed.split(separator: " ").count
            var score = letters * 2
            if wordCount > 1 { score += 5 }
            if wordCount >= 4 { score -= 8 }
            if entry.midY > 0.30 { score += 3 }
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
    ///   - X ∈ [1, 999]: any real Pokemon card number fits here. We do
    ///     NOT enforce X ≤ Y because **secret rares are numbered ABOVE
    ///     the printed total** — White Flare Hydreigon ex prints
    ///     `161/091`, Surging Sparks prints `223/191`, etc. Real-device
    ///     2026-05-04: White Flare Hydreigon ex went undetected through
    ///     three retries because the old `xInt <= yInt` filter silently
    ///     dropped every secret rare. The Y range above already filters
    ///     attack damage; the X cap of 999 catches OCR garbage without
    ///     rejecting real numbering.
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
            guard let xInt = Int(xStr), xInt >= 1, xInt <= 999 else { continue }
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
                   combinedInt >= 1,
                   combinedInt <= 999 {
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
            // CLIP's top-1 already agrees with OCR. The upstream
            // identifier (server route or OfflineIdentifier) already
            // analyzed dual-signal agreement and chose its
            // confidence accordingly — typically HIGH when both
            // signals point to the same slug. We TRUST that decision
            // here rather than re-applying the rule, because the
            // upstream also handles the trust-killer case where the
            // signals AGREE but still warrant a downgrade (e.g.,
            // ocr_intersect_unique that agrees with kNN top-1 but
            // the gap to rank-2 is borderline). Preserving
            // originalConfidence avoids the iOS reranker fighting
            // server-side downgrade decisions.
            return Result(
                matches: matches,
                confidence: originalConfidence,
                ocrNumberUsed: ocrNumber,
            )
        }

        // Promote the matching card to position 1, preserving the
        // relative order of everything else.
        var reordered: [ScanMatch] = []
        reordered.append(matches[promoteIndex])
        for (index, match) in matches.enumerated() where index != promoteIndex {
            reordered.append(match)
        }

        // OCR found a match further down the list and we promoted it
        // to top-1. This is the "OCR overrode CLIP" case the
        // upstream's trust-killer logic explicitly demotes to MEDIUM.
        // The previous behavior here unconditionally upgraded to HIGH,
        // which UNDOES that demotion — real-device 2026-05-06: Chansey
        // scan, OCR misread card_number as "3", Path B intersect-
        // unique picked Charizard #3, OfflineIdentifier correctly
        // returned MEDIUM (Path B changed CLIP top-1), but this
        // reranker promoted Charizard to top-1 AND set confidence
        // HIGH. Result: auto-navigate to Charizard for a card that
        // was actually a Chansey.
        //
        // Fix: reorder, but cap confidence at MEDIUM. If the user's
        // OCR was right we'll still land on the correct card via the
        // picker; if it was wrong (the Chansey case) the picker still
        // shows and the user can search-correct.
        let cappedConfidence: String
        switch originalConfidence {
        case "high":
            // Upstream said HIGH but OCR is overriding its top-1 —
            // disagreement, demote.
            cappedConfidence = "medium"
        default:
            // Already MEDIUM or LOW — preserve.
            cappedConfidence = originalConfidence
        }

        return Result(
            matches: reordered,
            confidence: cappedConfidence,
            ocrNumberUsed: ocrNumber,
        )
    }
}
