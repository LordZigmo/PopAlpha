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
import PopAlphaCore

enum ScanDebugCapture {

    /// Saves `image` with a result-summary banner to the user's
    /// Photos library. Always returns immediately — never blocks the
    /// scan flow.
    ///
    /// `ocrCardNumbers` is the full list of Vision transcription
    /// candidates (top-3 per text observation, deduped). Showing
    /// all candidates makes "OCR misread digit" failures self-evident
    /// in the saved frame: if candidate-1 is wrong but candidate-2
    /// is right, we want to see that in the banner.
    ///
    /// Saves HIGH-confidence scans too in DEBUG (not just MEDIUM/LOW).
    /// Without this, HIGH-but-wrong scans (the worst kind — auto-
    /// navigate to a wrong card) are invisible to the diagnostic
    /// trail. Real-device 2026-05-02: a Premium Power Pro scan
    /// auto-navigated to Pawniard at HIGH and we couldn't see the
    /// captured frame because HIGH was being skipped.
    ///
    /// Phase 0d (2026-05-08): the banner also surfaces the diagnostic
    /// fields we already collect during OCR (pass2_fired,
    /// spatial_rejected, frames_used, trigger_source, image_hash) so
    /// each saved photo is fully self-describing for 100-card
    /// triage. Previously the banner showed only the result + OCR
    /// candidates; failure-mode classification required cross-
    /// referencing PostHog and the Logger.scan stream.
    static func capture(
        image: UIImage,
        response: ScanIdentifyResponse?,
        source: ScanSource,
        ocrCardNumbers: [String],
        ocrSetHint: String?,
        triggerSource: String,
        framesUsed: Int,
        pass2FallbackFired: Bool,
        spatialFilterRejectedCount: Int,
        // Phase 0d (2026-05-15): perspective-correction geometry from
        // the embedder-side croppedToCard step. Nil when no
        // CIPerspectiveCorrection ran (library-import path, tap that
        // fell back to center-crop, or auto-detect that handed back a
        // failed crop). Surfaces a `persp:` line in the banner so a
        // Photos-library Mode 8 inspection is self-contained — both
        // the rendered image AND the corner→extent geometry that
        // produced it.
        perspectiveCorrection: PerspectiveCorrectionDiagnostics?,
    ) {

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
                triggerSource: triggerSource,
                framesUsed: framesUsed,
                pass2FallbackFired: pass2FallbackFired,
                spatialFilterRejectedCount: spatialFilterRejectedCount,
                perspectiveCorrection: perspectiveCorrection,
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

    /// Phase 0d follow-up (2026-05-08): auto-promote scans to the
    /// `scan_eval_images` corpus during the 100-card real-device ship
    /// test so each scan becomes a permanent eval-corpus row, not just
    /// a Photos-library frame. Without this the test gives one round
    /// of feedback; with it we accumulate a real-device-conditions
    /// corpus we can re-run the eval harness against after every
    /// future model-version bump.
    ///
    /// Routing rules:
    ///
    ///   - HIGH-confidence scan path: caller fires this with the
    ///     auto-navigated top-1 slug (presumed correct, marked
    ///     `presumed=true` in notes so post-test cleanup can filter
    ///     out HIGH-wrong cases by reviewing the saved Photos).
    ///   - Picker pick path: caller fires this with the user-picked
    ///     slug (definitively correct ground truth).
    ///   - LOW or no-pick: caller skips — no ground-truth label
    ///     available, no point polluting the corpus.
    ///
    /// **Bytes vs hash (2026-05-13, Codex P2 fix):** the
    /// `scanImage` parameter is the offline-path lifeline. Online scans
    /// land bytes at `scan-uploads/<hash>.jpg` server-side during
    /// `/api/scan/identify`, so the cheap hash-only `promoteEvalFromHash`
    /// suffices — the server `COPY`s the existing object into the eval
    /// prefix. Offline scans compute the hash locally and NEVER upload,
    /// so the hash-only route 404s ("source image not found at
    /// scan-uploads/<hash>.jpg"). Pre-fix, every offline HIGH/picker/
    /// search auto-promote silently failed and the 100-card eval
    /// corpus captured 0 offline frames — exactly the population we
    /// wanted to grow. When `scanImage` is non-nil we route to
    /// `promoteEvalFromBytes` (base64 multipart) instead. Callers in
    /// the offline path MUST pass the source UIImage; online callers
    /// can pass nil to save the re-encode.
    ///
    /// Auth: hits `/api/admin/scan-eval/promote` which requires admin
    /// Clerk role. In DEBUG that's only the dev's account anyway. A
    /// 401 just means the corpus row didn't land — the saved Photo
    /// still has the diagnostic banner, so the test isn't blocked.
    ///
    /// Fire-and-forget: never blocks the scan flow, never surfaces
    /// errors to UI. Logs failures to `Logger.scan` for review.
    static func autoPromoteToEval(
        imageHash: String,
        canonicalSlug: String,
        capturedSource: EvalCaptureSource,
        notesTag: String,
        scanImage: UIImage? = nil,
    ) {
        Task.detached(priority: .background) {
            do {
                let r: ScanEvalPromoteResponse
                if let image = scanImage {
                    // Offline path (or any caller that has the source
                    // bytes in memory). Bytes upload bypasses the
                    // server's hash-copy-from-scan-uploads step.
                    r = try await ScanService.promoteEvalFromBytes(
                        image: image,
                        canonicalSlug: canonicalSlug,
                        source: capturedSource,
                        notes: notesTag,
                    )
                } else {
                    // Online path: bytes already at scan-uploads/<hash>.jpg
                    // from /api/scan/identify, so the server can copy
                    // server-side without us re-uploading.
                    r = try await ScanService.promoteEvalFromHash(
                        imageHash: imageHash,
                        canonicalSlug: canonicalSlug,
                        source: capturedSource,
                        notes: notesTag,
                    )
                }
                if r.ok {
                    Logger.scan.debug("auto-promoted to eval: hash=\(imageHash.prefix(8)) slug=\(canonicalSlug) tag=\(notesTag) via=\(scanImage != nil ? "bytes" : "hash")")
                } else {
                    Logger.scan.debug("auto-promote rejected: hash=\(imageHash.prefix(8)) error=\(r.error ?? "nil")")
                }
            } catch {
                Logger.scan.debug("auto-promote failed: \(error.localizedDescription)")
            }
        }
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
    /// One slug per line, similarity to 3 decimals. Last line carries
    /// the OCR/path diagnostic flags so failure-mode triage on the
    /// 100-card ship test is fully self-contained per saved photo.
    private static func makeBanner(
        response: ScanIdentifyResponse?,
        source: ScanSource,
        ocrCardNumbers: [String],
        ocrSetHint: String?,
        triggerSource: String,
        framesUsed: Int,
        pass2FallbackFired: Bool,
        spatialFilterRejectedCount: Int,
        perspectiveCorrection: PerspectiveCorrectionDiagnostics?,
    ) -> String {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var lines: [String] = []
        // Header line: WHEN + WHERE the scan came from.
        lines.append("[\(timestamp)] src=\(source.rawValue) trig=\(triggerSource) frames=\(framesUsed)")
        if let r = response {
            // Result line: confidence + path + image_hash short suffix
            // (correlates this Photos image to scan_eval_images /
            // PostHog when promoting or filing a regression).
            let hashSuffix = (r.imageHash ?? "").prefix(8)
            lines.append("conf=\(r.confidence) path=\(r.winningPath ?? "nil") hash=\(hashSuffix)")
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
        // Diagnostic flags — surface what the OCR pipeline actually
        // had to do. pass2=true means pass-1 spatial filter failed
        // and we recovered via the fallback; rejected>0 means Vision
        // observations were dropped before reaching the parser. Both
        // strongly inform "is this a Mode 6 / Mode 8 case?" without
        // needing PostHog or the log stream.
        lines.append("pass2=\(pass2FallbackFired) rejected=\(spatialFilterRejectedCount)")
        // Phase 0d (2026-05-15) — perspective-correction geometry. The
        // input quadrilateral corners are normalized to the input
        // bitmap so they're roughly comparable across cards regardless
        // of capture resolution. portrait_rot=true means step 4 had to
        // rotate 90° (the original perspective output was landscape) —
        // every such case is a candidate for Mode 8's upside-down
        // ambiguity. out=(WxH) lets you see whether the corrected
        // rectangle came back portrait-shaped (good) or square-ish
        // (suspicious — Vision may have locked onto a sub-card region).
        if let p = perspectiveCorrection {
            let inW = Int(p.inputSize.width)
            let inH = Int(p.inputSize.height)
            let outW = Int(p.outputExtent.width)
            let outH = Int(p.outputExtent.height)
            let cornersNorm = p.inputCorners.map { c in
                String(format: "(%.2f,%.2f)",
                       inW > 0 ? c.x / Double(inW) : 0,
                       inH > 0 ? c.y / Double(inH) : 0)
            }.joined(separator: " ")
            lines.append("persp: in=\(inW)x\(inH) out=\(outW)x\(outH) portrait_rot=\(p.portraitRotationApplied)")
            lines.append("persp_corners(tl,tr,bl,br norm): \(cornersNorm)")
        } else {
            lines.append("persp: none (center-crop / library / no rectangle)")
        }
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
