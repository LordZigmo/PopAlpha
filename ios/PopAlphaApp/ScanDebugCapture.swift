// ScanDebugCapture.swift
//
// DEBUG-only hook that saves the EXACT UIImage `runIdentify` fed to
// the embedder when a scan came back low or medium confidence. The
// saved image carries a banner overlay summarizing the scan result,
// so opening Photos later shows you both what was captured AND what
// the system thought it was looking at — without context-switching
// to logs.
//
// WHY THIS MATTERS:
//
//   When real-device scans surface unexpected matches (e.g.
//   Garganacl → Iono's Kilowattrel), the question "is the embedder
//   broken or the capture wrong?" is most cheaply answered by
//   eyeballing the actual frame. The catalog-roundtrip smoke check
//   (Tier 7) verifies the pipeline; this hook lets us see the input.
//
// GATING:
//
//   - #if DEBUG: removed from release builds entirely.
//   - confidence != "high": only saves problematic scans, so the
//     library doesn't fill with successful frames during normal use.
//   - Photo permission: already declared via
//     NSPhotoLibraryUsageDescription in Info.plist (the eval-seeding
//     flow uses it). PHPhotoLibrary.requestAuthorization fires the
//     system prompt the first time.
//
// NO PII / NETWORK:
//
//   The image goes to the user's own Photos library, never off-
//   device. Result metadata is written into the burned banner only.

#if DEBUG

import UIKit
import Photos
import OSLog

enum ScanDebugCapture {

    /// Saves `image` with a result-summary banner to the user's
    /// Photos library if the scan was low/medium confidence. Always
    /// returns immediately — never blocks the scan flow.
    ///
    /// `ocrCardNumbers` is the full list of Vision transcription
    /// candidates (top-3 per text observation, deduped). Showing
    /// all candidates makes "OCR misread digit" failures self-evident
    /// in the saved frame: if candidate-1 is wrong but candidate-2
    /// is right, we want to see that in the banner.
    static func capture(
        image: UIImage,
        response: ScanIdentifyResponse?,
        source: ScanSource,
        ocrCardNumbers: [String],
        ocrSetHint: String?,
    ) {
        // Only persist questionable results — high-confidence scans
        // worked, no need to clutter Photos.
        let confidence = response?.confidence ?? "error"
        guard confidence != "high" else { return }

        Task.detached(priority: .background) {
            // Permission. We try addOnly first (newer, narrower) and
            // fall back to .readWrite so older OS versions still work.
            let granted = await Self.ensurePhotoAddPermission()
            guard granted else {
                Logger.scan.debug("photo permission not granted; skipping capture save")
                return
            }
            let banner = Self.makeBanner(
                response: response,
                source: source,
                ocrCardNumbers: ocrCardNumbers,
                ocrSetHint: ocrSetHint,
            )
            let composed = Self.compose(image: image, banner: banner)
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.creationRequestForAsset(from: composed)
                }
                Logger.scan.debug("saved capture to Photos: \(banner.replacingOccurrences(of: "\n", with: " | "))")
            } catch {
                Logger.scan.debug("save failed: \(error.localizedDescription)")
            }
        }
    }

    enum ScanSource: String {
        case offline
        case network
    }

    // MARK: - Permission

    private static func ensurePhotoAddPermission() async -> Bool {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current == .authorized || current == .limited { return true }
        return await withCheckedContinuation { cont in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                cont.resume(returning: status == .authorized || status == .limited)
            }
        }
    }

    // MARK: - Banner generation

    /// Produces a multi-line text banner with the result + OCR signal.
    /// One slug per line, similarity to 3 decimals.
    private static func makeBanner(
        response: ScanIdentifyResponse?,
        source: ScanSource,
        ocrCardNumbers: [String],
        ocrSetHint: String?,
    ) -> String {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var lines: [String] = []
        lines.append("[\(timestamp)] src=\(source.rawValue)")
        if let r = response {
            lines.append("conf=\(r.confidence) path=\(r.winningPath ?? "nil")")
            for (i, m) in r.matches.prefix(5).enumerated() {
                lines.append(String(
                    format: "%d. %@ (sim=%.3f, %@ #%@)",
                    i + 1,
                    m.slug,
                    m.similarity,
                    m.setName ?? "?",
                    m.cardNumber ?? "?",
                ))
            }
        } else {
            lines.append("ERROR: no response (identify threw)")
        }
        // Show ALL OCR card-number candidates Vision returned, in
        // confidence order. Misreads ("0" → "1" under glare) become
        // visible: the right number is often candidate-2 or 3.
        let nums = ocrCardNumbers.isEmpty ? "nil" : ocrCardNumbers.joined(separator: ",")
        lines.append("OCR nums=[\(nums)] set=\(ocrSetHint ?? "nil")")
        return lines.joined(separator: "\n")
    }

    // MARK: - Image composition

    /// Stacks `image` underneath a fixed-width text banner. Banner
    /// height is computed from the wrapped text. White text on a
    /// dark translucent background so it's readable against any
    /// scan content.
    private static func compose(image: UIImage, banner: String) -> UIImage {
        let scale: CGFloat = image.scale
        let imgSize = image.size
        let bannerWidth = imgSize.width
        let font = UIFont.monospacedSystemFont(ofSize: max(11, imgSize.width / 32), weight: .regular)
        let textPadding: CGFloat = 12

        // Wrap the text into a NSAttributedString to get its rendered
        // height. We pre-render to a context to measure, then compose
        // for real.
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white,
        ]
        let attributedBanner = NSAttributedString(string: banner, attributes: attrs)
        let constrainedSize = CGSize(width: bannerWidth - 2 * textPadding, height: .greatestFiniteMagnitude)
        let textRect = attributedBanner.boundingRect(
            with: constrainedSize,
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil,
        )
        let bannerHeight = ceil(textRect.height) + 2 * textPadding

        let totalSize = CGSize(width: imgSize.width, height: imgSize.height + bannerHeight)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        let renderer = UIGraphicsImageRenderer(size: totalSize, format: format)

        let composed = renderer.image { ctx in
            // Banner background
            UIColor.black.withAlphaComponent(0.85).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: totalSize.width, height: bannerHeight))

            // Banner text
            attributedBanner.draw(in: CGRect(
                x: textPadding,
                y: textPadding,
                width: constrainedSize.width,
                height: ceil(textRect.height),
            ))

            // Original image
            image.draw(in: CGRect(
                x: 0,
                y: bannerHeight,
                width: imgSize.width,
                height: imgSize.height,
            ))
        }
        return composed
    }
}

#endif
