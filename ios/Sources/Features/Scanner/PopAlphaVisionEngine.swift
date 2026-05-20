import AVFoundation
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreML
import ImageIO
import UIKit
import VideoToolbox
import Vision

/// Phase 0d (2026-05-15): structured diagnostics emitted from
/// `croppedToCard` so downstream code can correlate a captured frame
/// with the geometry of its perspective-correction step. The data is the
/// minimum needed to reverse-engineer the Mode 8 coordinate-system quirk
/// (`scanner-ocr-failure-modes.md`) from real-device samples: the four
/// Vision corners in pixel space, the resulting CIImage extent, the
/// pre-correction bitmap size, and whether step 4's portrait rotation
/// ran. Serializes to JSON for `scan_identify_events.ocr_perspective_corrected_extent`
/// (server-routed) and PostHog `card_scanned` properties (offline).
public struct PerspectiveCorrectionDiagnostics: Codable, Sendable, Equatable {
    public struct Point: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
    }
    public struct Size: Codable, Sendable, Equatable {
        public let width: Double
        public let height: Double
    }
    public struct Rect: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }

    /// Four corners passed to `CIPerspectiveCorrection`, in pixel space,
    /// ordered `[topLeft, topRight, bottomLeft, bottomRight]` to match the
    /// filter's input contract.
    public let inputCorners: [Point]
    /// CIImage extent of the perspective-corrected output, BEFORE the
    /// step-4 portrait rotation. Reveals whether the filter produced a
    /// portrait or landscape rectangle.
    public let outputExtent: Rect
    /// Dimensions of the bitmap that was passed into the filter (step-1
    /// re-rendered up-oriented image). The corner coordinates are in this
    /// pixel space.
    public let inputSize: Size
    /// True when step 4's 90° clockwise rotation ran — i.e., the
    /// perspective-corrected output was wider than tall and we forced
    /// portrait. This is where the ~50% upside-down rotation ambiguity
    /// originates.
    public let portraitRotationApplied: Bool

    /// Flat-keyed dictionary suitable for PostHog `card_scanned`
    /// properties (offline path). Server-routed scans send the full
    /// struct as a JSON query param that lands in
    /// `scan_identify_events.ocr_perspective_corrected_extent`; PostHog
    /// gets the aggregate-query-friendly subset here. Caller layers
    /// in `"ocr_perspective_corrected": false` for the nil case.
    public var postHogProperties: [String: Any] {
        return [
            "ocr_perspective_corrected": true,
            "ocr_perspective_portrait_rotation_applied": portraitRotationApplied,
            "ocr_perspective_input_w": Int(inputSize.width),
            "ocr_perspective_input_h": Int(inputSize.height),
            "ocr_perspective_output_w": Int(outputExtent.width),
            "ocr_perspective_output_h": Int(outputExtent.height),
        ]
    }
}

public protocol PopAlphaVisionEngineDelegate: AnyObject {
    /// Legacy entry point kept for source compatibility. The engine itself
    /// only invokes `didDetectStableCard(image:perspectiveCorrection:triggerKind:)`;
    /// existing implementers that only override the unary form receive the
    /// image via the default-implementation forwarders below.
    func didDetectStableCard(image: UIImage)

    /// Phase 0d (2026-05-15) — receives Mode 8 diagnostic data alongside
    /// the cropped card. `perspectiveCorrection` is nil only when
    /// `croppedToCard` failed (caller falls back to the full frame).
    /// Default implementation forwards to the unary `didDetectStableCard`
    /// so older implementers compile unchanged.
    func didDetectStableCard(image: UIImage, perspectiveCorrection: PerspectiveCorrectionDiagnostics?)

    /// 2026-05-16 — receives the trigger kind alongside the cropped card.
    /// `"auto"` for the rectangle stability-gate path; `"auto_saliency"`
    /// for the full-art fallback path that runs
    /// `VNGenerateAttentionBasedSaliencyImageRequest` when the rectangle
    /// detector hasn't produced an observation for a sustained window.
    /// Default implementation forwards to the two-arg method so older
    /// implementers compile unchanged.
    func didDetectStableCard(
        image: UIImage,
        perspectiveCorrection: PerspectiveCorrectionDiagnostics?,
        triggerKind: String,
    )

    /// Fires every frame that the engine has a live candidate rectangle, and
    /// with `nil` when the candidate expires. Bounding box is in Vision's
    /// normalized coordinate space (origin bottom-left, 0–1 range).
    /// Default implementation is a no-op so existing conformers don't break.
    func didUpdateCandidateBoundingBox(_ normalizedBoundingBox: CGRect?)
}

public extension PopAlphaVisionEngineDelegate {
    func didDetectStableCard(image: UIImage, perspectiveCorrection: PerspectiveCorrectionDiagnostics?) {
        didDetectStableCard(image: image)
    }

    func didDetectStableCard(
        image: UIImage,
        perspectiveCorrection: PerspectiveCorrectionDiagnostics?,
        triggerKind: String,
    ) {
        didDetectStableCard(image: image, perspectiveCorrection: perspectiveCorrection)
    }

    func didUpdateCandidateBoundingBox(_ normalizedBoundingBox: CGRect?) {}
}

public final class PopAlphaVisionEngine {
    public weak var delegate: PopAlphaVisionEngineDelegate?

    /// Phase 0d (2026-05-15) — most recent perspective-correction
    /// diagnostic that *the consumer chose to publish*. Writable so
    /// the tap path can explicitly stash only when the produced crop
    /// is actually used (i.e., `detectAndCrop` returned a quadrilateral
    /// AND `ScannerView.isPlausibleCardCrop` accepted it). The engine
    /// itself does NOT auto-stash from `croppedToCard`, because the
    /// "auto-detect produced a crop" condition is not equivalent to
    /// "the crop reaches the embedder": Vision can lock onto a 112×116
    /// sub-card noise region that the downstream sanity check
    /// (`isPlausibleCardCrop`) rejects, and we don't want the
    /// diagnostic from that rejected region attached to the
    /// center-crop fallback that actually flows downstream.
    ///
    /// Tap-path contract:
    ///   - `ScannerView.captureCurrentFrame` writes nil on entry
    ///     (clean slate), then on a successful + accepted detection
    ///     writes the diagnostic. Rejection / no-rectangle paths
    ///     leave it nil.
    ///   - `ScannerTabView.captureFrameAndIdentify` reads it
    ///     immediately after the primary `frameCapturer()` call,
    ///     BEFORE the multi-frame OCR loop overwrites it with
    ///     subsequent frames' results.
    ///
    /// Auto-detect path does NOT use this property — it receives the
    /// diagnostic synchronously via the
    /// `didDetectStableCard(image:perspectiveCorrection:)` delegate
    /// parameter and never reads back from the engine.
    public var lastPerspectiveCorrection: PerspectiveCorrectionDiagnostics?

    public let minimumStableDuration: TimeInterval
    public let aspectRatioTolerance: CGFloat
    public let allowedMissDuration: TimeInterval
    public let minimumCardSize: CGFloat

    private let analysisQueue = DispatchQueue(
        label: "com.popalpha.vision-engine.analysis",
        qos: .userInitiated
    )
    private let callbackQueue: DispatchQueue
    private let frameGate = DispatchSemaphore(value: 1)

    private let expectedCardAspectRatio = CGFloat(2.5 / 3.5)
    private lazy var rectangleRequest: VNDetectRectanglesRequest = makeRectangleRequest()
    private var candidate: StableCandidate?

    /// Number of seconds a candidate must exist before its bounding box is published
    /// to the tracking overlay. Filters out first-frame noise from the rectangle
    /// detector, which tends to be the least accurate frame.
    private let publishWarmupDuration: TimeInterval = 0.15

    /// EMA smoothing factor applied to published bounding boxes. Lower = smoother,
    /// higher = more responsive. 0.35 damps jitter while still following hand motion.
    private let boundingBoxSmoothing: CGFloat = 0.35

    /// Last published (smoothed) bounding box, used as the EMA "previous" value.
    /// Cleared when the candidate expires or resets.
    private var smoothedPublishedBox: CGRect?

    // MARK: - Saliency fallback (2026-05-16)
    //
    // Full-art / VMax / VSTAR / ex cards have artwork that bleeds to
    // the card border. `VNDetectRectanglesRequest` requires an edge
    // gradient between card and background to fire — those cards
    // present zero gradient, so the rectangle detector silently never
    // produces an observation and auto-capture never fires. Users
    // discover the manual-tap escape hatch (`captureFrameAndIdentify`),
    // but the user-facing complaint is that the scanner "doesn't even
    // recognize" full-arts. The matching side (SigLIP-2 kNN at
    // `/api/scan/identify`) already handles full-arts correctly when
    // they reach it — the gap is purely the trigger.
    //
    // Fallback strategy: when the rectangle detector hasn't produced
    // an observation for `saliencyFallbackDelay` seconds, run
    // `VNGenerateAttentionBasedSaliencyImageRequest` on the same
    // pixel buffer. It returns a list of salient objects (a card held
    // in front of any background is a strong salient object regardless
    // of how the art reaches the edges) — apply the same stability
    // gate as the rectangle path, then fire the existing delegate with
    // `triggerKind: "auto_saliency"` so telemetry can segment hit rate
    // vs. the rectangle path. Saliency runs on Neural Engine, ~10ms
    // per frame; only invoked when the streak threshold is reached, so
    // negligible cost on the common path.

    private lazy var saliencyRequest: VNGenerateAttentionBasedSaliencyImageRequest =
        makeSaliencyRequest()
    private var salientCandidate: SalientCandidate?

    /// Wall-clock timestamp when the most recent run of consecutive
    /// rect-detector misses began. Reset to `nil` on any frame that
    /// produces a rectangle observation. Saliency runs only when
    /// `timestamp - firstNoObservationAt >= saliencyFallbackDelay`.
    private var firstNoObservationAt: TimeInterval?

    /// Wall-clock timestamp of the most recent saliency-path delegate
    /// fire. Used for post-fire cooldown. NOT cleared by `reset()` —
    /// `reset()` runs on LOW silent re-arm, and clearing it there would
    /// re-permit immediate re-fire on a static scene (e.g., phone-on-
    /// desk loop). Set to `0` initially so the first saliency fire is
    /// always permitted.
    private var lastSaliencyFireAt: TimeInterval = 0

    /// Seconds the rectangle detector must produce no observations
    /// before saliency takes over. Loose enough that handheld jitter
    /// can briefly miss frames without triggering saliency, tight
    /// enough that the user perceives "scanner is trying" on full-art
    /// cards.
    private let saliencyFallbackDelay: TimeInterval = 1.5

    /// Minimum wall-clock seconds between saliency-path fires. Prevents
    /// the phone-on-desk loop: saliency would otherwise re-trigger
    /// every `saliencyFallbackDelay` + `minimumStableDuration` after
    /// every LOW silent re-arm. 8s is empirically chosen to cover a
    /// typical "user reviewing result" pause while still allowing
    /// scanning the next card without noticeable delay.
    private let saliencyCooldown: TimeInterval = 8.0

    /// When false, the saliency fallback path is fully disabled — the
    /// engine acts as if `VNGenerateAttentionBasedSaliencyImageRequest`
    /// doesn't exist. Multi-scan mode flips this off because saliency's
    /// `isPlausibleSalientBox` aspect gate is loose enough that books,
    /// phones, and food packages also pass — and once they pass, the
    /// SigLIP kNN admits them as MEDIUM/HIGH matches that silently
    /// accumulate into the review tray. Single-scan mode keeps it on
    /// so full-arts (the original motivation for the fallback) still
    /// auto-trigger. Targeted fix landing while we collect telemetry
    /// to inform a systemic post-identify sim floor for `auto_saliency`
    /// triggers; see `scanner-ocr-failure-modes.md` 2026-05-20 entry.
    public var isSaliencyEnabled: Bool = true {
        didSet {
            guard !isSaliencyEnabled else { return }
            analysisQueue.async { [weak self] in
                self?.firstNoObservationAt = nil
                self?.salientCandidate = nil
            }
        }
    }

    public init(
        delegate: PopAlphaVisionEngineDelegate? = nil,
        callbackQueue: DispatchQueue = .main,
        minimumStableDuration: TimeInterval = 0.5,
        aspectRatioTolerance: CGFloat = 0.10,
        minimumCardSize: CGFloat = 0.11,
        allowedMissDuration: TimeInterval = 0.15
    ) {
        self.delegate = delegate
        self.callbackQueue = callbackQueue
        self.minimumStableDuration = minimumStableDuration
        self.aspectRatioTolerance = aspectRatioTolerance
        self.minimumCardSize = minimumCardSize
        self.allowedMissDuration = allowedMissDuration
    }

    public func process(
        sampleBuffer: CMSampleBuffer,
        orientation: CGImagePropertyOrientation = .right
    ) {
        guard CMSampleBufferGetImageBuffer(sampleBuffer) != nil else {
            return
        }

        guard frameGate.wait(timeout: .now()) == .success else {
            return
        }

        let signal = frameGate

        analysisQueue.async { [weak self] in
            defer { signal.signal() }

            guard let self else {
                return
            }

            autoreleasepool {
                self.analyze(sampleBuffer: sampleBuffer, orientation: orientation)
            }
        }
    }

    public func reset() {
        analysisQueue.async {
            self.candidate = nil
            self.smoothedPublishedBox = nil
            self.rectangleRequest.regionOfInterest = Self.fullFrameROI
            // Short-term saliency state — same scope as `candidate`.
            // `lastSaliencyFireAt` is intentionally NOT reset: `reset()`
            // fires on LOW silent re-arm, and a cleared cooldown there
            // would re-permit immediate re-fire on a static scene.
            self.salientCandidate = nil
            self.firstNoObservationAt = nil
            self.notifyCandidateUpdated(nil)
        }
    }

    private func notifyCandidateUpdated(_ boundingBox: CGRect?) {
        callbackQueue.async { [weak self] in
            guard let self else { return }
            self.delegate?.didUpdateCandidateBoundingBox(boundingBox)
        }
    }

    /// Blend a raw bounding box with the previously published one to dampen
    /// frame-to-frame jitter from the rectangle detector. Called only after
    /// the candidate has passed the warmup threshold.
    private func emaSmoothed(_ raw: CGRect) -> CGRect {
        guard let previous = smoothedPublishedBox else { return raw }
        let a = boundingBoxSmoothing
        let blended = CGRect(
            x: previous.origin.x * (1 - a) + raw.origin.x * a,
            y: previous.origin.y * (1 - a) + raw.origin.y * a,
            width: previous.width * (1 - a) + raw.width * a,
            height: previous.height * (1 - a) + raw.height * a
        )
        return blended
    }

    private func analyze(
        sampleBuffer: CMSampleBuffer,
        orientation: CGImagePropertyOrientation
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }

        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        rectangleRequest.regionOfInterest = regionOfInterestForCurrentCandidate()

        let requestHandler = VNImageRequestHandler(
            cvPixelBuffer: pixelBuffer,
            orientation: orientation,
            options: [:]
        )

        var observation: VNRectangleObservation?
        do {
            try requestHandler.perform([rectangleRequest])
            observation = bestCardObservation(from: rectangleRequest.results ?? [])
            updateCandidate(
                with: observation,
                at: timestamp,
                pixelBuffer: pixelBuffer,
                orientation: orientation
            )
        } catch {
            expireCandidateIfNeeded(at: timestamp)
        }

        // Saliency fallback — runs ONLY when the rectangle detector
        // has been failing for `saliencyFallbackDelay` seconds. See
        // the "Saliency fallback" section at the top of the type for
        // the full motivation; the short version is "full-art cards
        // have no edge gradient, so the rectangle detector never
        // fires." Streak is reset on any successful rectangle obs.
        // Reuses the existing `requestHandler` so we don't pay the
        // cost of building a second one over the same pixel buffer.
        //
        // Also reset (and skip the analyzer) when `isSaliencyEnabled`
        // is false — multi-scan mode flips it off to avoid false-
        // positive triggers on non-card objects polluting the tray.
        if observation != nil || !isSaliencyEnabled {
            firstNoObservationAt = nil
            salientCandidate = nil
        } else {
            if firstNoObservationAt == nil {
                firstNoObservationAt = timestamp
            }
            let streak = timestamp - (firstNoObservationAt ?? timestamp)
            let cooldownElapsed = timestamp - lastSaliencyFireAt >= saliencyCooldown
            if streak >= saliencyFallbackDelay, cooldownElapsed {
                analyzeSaliency(
                    handler: requestHandler,
                    at: timestamp,
                    pixelBuffer: pixelBuffer,
                    orientation: orientation
                )
            }
        }
    }

    private func makeRectangleRequest() -> VNDetectRectanglesRequest {
        let request = VNDetectRectanglesRequest()
        // Apple has only ever shipped Revision 1 for VNDetectRectanglesRequest;
        // no newer revision to upgrade to. The improvement work in this
        // change is the threshold loosening below.
        request.revision = VNDetectRectanglesRequestRevision1
        request.preferBackgroundProcessing = false
        // Loosened from 0.85 → 0.70 to handle finger-shadow / hand-occlusion
        // cases. Real-device 2026-05-03: card held between fingers with a
        // shadow on the edge → Vision saw an edge gradient softer than
        // 0.85 → no detection → user had to physically move their finger
        // before the scanner would fire. Risk profile is asymmetric in
        // our favor: false positives (a tabletop edge / book spine
        // mistakenly classified as a rectangle) flow through to the
        // embedder which returns sim<0.70 → LOW confidence → silent
        // re-arm with no user-visible disruption. False negatives force
        // physical-world recovery.
        request.minimumConfidence = 0.70
        request.minimumSize = Float(minimumCardSize)
        request.minimumAspectRatio = Float(max(0.0, expectedCardAspectRatio - aspectRatioTolerance))
        request.maximumAspectRatio = Float(min(1.0, expectedCardAspectRatio + aspectRatioTolerance))
        // 18° → 25° accommodates the ~5-10° apparent skew a finger pushes
        // into a card edge before reaching the threshold for rejection.
        request.quadratureTolerance = 25
        request.maximumObservations = 3
        request.regionOfInterest = Self.fullFrameROI

        configurePreferredComputeDevices(for: request)
        return request
    }

    private func bestCardObservation(
        from observations: [VNRectangleObservation]
    ) -> VNRectangleObservation? {
        observations
            .filter {
                isCardAspectRatio($0)
                    && $0.boundingBox.width >= minimumCardSize
                    && $0.boundingBox.height >= minimumCardSize
            }
            .max { lhs, rhs in
                observationScore(lhs) < observationScore(rhs)
            }
    }

    // MARK: - Saliency fallback helpers

    private func makeSaliencyRequest() -> VNGenerateAttentionBasedSaliencyImageRequest {
        let request = VNGenerateAttentionBasedSaliencyImageRequest()
        configurePreferredComputeDevices(for: request)
        return request
    }

    /// Generic Neural Engine / GPU placement for any VNImageBasedRequest.
    /// Mirrors the rectangle-request configuration but accepts the broader
    /// protocol so the saliency request (a non-rectangle request) can
    /// share the same logic.
    private func configurePreferredComputeDevices(for request: VNImageBasedRequest) {
        guard #available(iOS 17.0, *) else { return }
        guard let supportedDevices = try? request.supportedComputeStageDevices else {
            return
        }
        for (stage, devices) in supportedDevices {
            if let neuralEngine = devices.first(where: {
                if case .neuralEngine = $0 { return true }
                return false
            }) {
                request.setComputeDevice(neuralEngine, for: stage)
                continue
            }
            if let gpu = devices.first(where: {
                if case .gpu = $0 { return true }
                return false
            }) {
                request.setComputeDevice(gpu, for: stage)
            }
        }
    }

    /// Runs `VNGenerateAttentionBasedSaliencyImageRequest` on the current
    /// frame and threads any salient observation through the same
    /// stability-gate-then-deliver flow the rectangle path uses. Called
    /// only when `analyze()` determines the rectangle path has been
    /// silent for `saliencyFallbackDelay` seconds AND cooldown has
    /// elapsed.
    private func analyzeSaliency(
        handler: VNImageRequestHandler,
        at timestamp: TimeInterval,
        pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation,
    ) {
        do {
            try handler.perform([saliencyRequest])
        } catch {
            return
        }
        guard let salientObjects = (saliencyRequest.results as? [VNSaliencyImageObservation])?
                .first?.salientObjects, !salientObjects.isEmpty else {
            salientCandidate = nil
            return
        }
        let best = bestSalientObservation(from: salientObjects)
        updateSalientCandidate(
            with: best,
            at: timestamp,
            pixelBuffer: pixelBuffer,
            orientation: orientation,
        )
    }

    /// Of the salient-object observations from the saliency request,
    /// pick the one that looks most card-like. The saliency detector
    /// always produces *some* observation given non-uniform content —
    /// uniform surface like a clean desk → rectangles distributed
    /// across the frame. The aspect/size sanity check (§
    /// `isPlausibleSalientBox`) filters those out so a phone pointed
    /// at the desk doesn't fire the auto-trigger.
    ///
    /// Returns nil when no observation passes sanity. The caller leaves
    /// `salientCandidate` cleared, which keeps the stability counter
    /// from advancing across un-related frames.
    private func bestSalientObservation(
        from observations: [VNRectangleObservation]
    ) -> VNRectangleObservation? {
        observations
            .filter { Self.isPlausibleSalientBox($0.boundingBox) }
            .max { lhs, rhs in
                (lhs.boundingBox.width * lhs.boundingBox.height) <
                (rhs.boundingBox.width * rhs.boundingBox.height)
            }
    }

    /// Stability gate for the saliency path. Mirrors `updateCandidate`'s
    /// behavior for the rectangle path: a salient observation must
    /// persist for `minimumStableDuration` seconds in roughly the same
    /// position before we promote it to a delegate fire. Uses IoU >=
    /// 0.7 as the "same region" predicate, which is looser than the
    /// rectangle path's `matches()` (saliency observations can jitter
    /// more frame-to-frame because they're not corner-locked).
    private func updateSalientCandidate(
        with observation: VNRectangleObservation?,
        at timestamp: TimeInterval,
        pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation,
    ) {
        guard let observation else {
            salientCandidate = nil
            return
        }

        if var existing = salientCandidate,
           intersectionOverUnion(existing.boundingBox, observation.boundingBox) >= 0.7 {
            existing.boundingBox = observation.boundingBox
            existing.lastSeenAt = timestamp
            salientCandidate = existing
        } else {
            salientCandidate = SalientCandidate(
                boundingBox: observation.boundingBox,
                firstSeenAt: timestamp,
                lastSeenAt: timestamp,
                hasTriggered: false,
            )
        }

        guard var stableSalient = salientCandidate else { return }
        guard !stableSalient.hasTriggered else { return }
        guard timestamp - stableSalient.firstSeenAt >= minimumStableDuration else { return }

        stableSalient.hasTriggered = true
        salientCandidate = stableSalient

        guard let frame = makeImage(from: pixelBuffer, orientation: orientation) else {
            return
        }
        let cropped = cropToSalient(frame, boundingBox: stableSalient.boundingBox) ?? frame

        // Stamp the fire time BEFORE dispatching so concurrent frames
        // entering analyze() observe an active cooldown immediately.
        lastSaliencyFireAt = timestamp

        callbackQueue.async { [weak self] in
            guard let self else { return }
            self.delegate?.didDetectStableCard(
                image: cropped,
                perspectiveCorrection: nil,
                triggerKind: "auto_saliency",
            )
        }
    }

    /// Crop the frame to the salient bounding box with ~4% edge
    /// padding. Vision's saliency boxes can sit slightly inside the
    /// card boundary; the padding restores a margin so the embedder
    /// sees the full card art the same way it would on a clean
    /// rectangle-detected crop. Returns nil only when the frame has
    /// no CGImage or zero size — caller falls back to the full frame.
    private func cropToSalient(_ image: UIImage, boundingBox: CGRect) -> UIImage? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }

        // Re-render to bake any UIImage.imageOrientation flag into the
        // pixel buffer — `CGImage.cropping(to:)` operates in raw pixel
        // space and would otherwise crop relative to the unrotated
        // bitmap, not the visually-correct frame.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let flat = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let cgImage = flat.cgImage else { return nil }

        let padX = boundingBox.width * 0.04
        let padY = boundingBox.height * 0.04
        let paddedMinX = max(0, boundingBox.minX - padX)
        let paddedMinY = max(0, boundingBox.minY - padY)
        let paddedMaxX = min(1, boundingBox.maxX + padX)
        let paddedMaxY = min(1, boundingBox.maxY + padY)
        let paddedW = paddedMaxX - paddedMinX
        let paddedH = paddedMaxY - paddedMinY
        guard paddedW > 0, paddedH > 0 else { return nil }

        // Vision's normalized bounding box uses a bottom-left origin;
        // CGImage uses top-left. Flip the Y axis when projecting into
        // pixel space.
        let cropRect = CGRect(
            x: paddedMinX * size.width,
            y: (1 - paddedMaxY) * size.height,
            width: paddedW * size.width,
            height: paddedH * size.height,
        )
        guard let cropped = cgImage.cropping(to: cropRect) else { return nil }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    /// Reject salient regions that aren't shaped like a Pokemon TCG
    /// card. The detector always finds *something* in the frame —
    /// without this gate, a phone pointed at a clean desk would lock
    /// onto whatever low-contrast feature ranked highest and fire
    /// the auto-trigger, burning the user's daily scan quota.
    ///
    /// Constraints:
    ///   - Short side ≥ 25% of frame (rejects tiny salient patches).
    ///   - Aspect ratio in [0.45, 0.95] — looser than the rectangle
    ///     path's [0.604, 0.804] because saliency can include some
    ///     surrounding context around the card.
    private static func isPlausibleSalientBox(_ box: CGRect) -> Bool {
        let w = box.width
        let h = box.height
        let shortSide = min(w, h)
        let longSide = max(w, h)
        guard shortSide >= 0.25 else { return false }
        guard longSide > 0 else { return false }
        let aspect = shortSide / longSide
        return aspect >= 0.45 && aspect <= 0.95
    }

    private func updateCandidate(
        with observation: VNRectangleObservation?,
        at timestamp: TimeInterval,
        pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation
    ) {
        guard let observation else {
            expireCandidateIfNeeded(at: timestamp)
            return
        }

        if var existingCandidate = candidate, matches(existingCandidate.observation, observation) {
            existingCandidate.observation = observation
            existingCandidate.lastSeenAt = timestamp
            candidate = existingCandidate
        } else {
            // New candidate — reset the smoothed box so we don't blend across
            // unrelated detections from different parts of the frame.
            candidate = StableCandidate(
                observation: observation,
                firstSeenAt: timestamp,
                lastSeenAt: timestamp,
                hasTriggered: false
            )
            smoothedPublishedBox = nil
        }

        // Publish only AFTER a short warmup window. The first 150 ms of any new
        // candidate is where the rectangle detector is least certain — showing
        // the overlay immediately leads to flicker and tiny/thin spurious boxes.
        if let candidate,
           timestamp - candidate.firstSeenAt >= publishWarmupDuration {
            let smoothed = emaSmoothed(observation.boundingBox)
            smoothedPublishedBox = smoothed
            notifyCandidateUpdated(smoothed)
        }

        guard var stableCandidate = candidate else {
            return
        }

        guard !stableCandidate.hasTriggered else {
            return
        }

        guard timestamp - stableCandidate.firstSeenAt >= minimumStableDuration else {
            return
        }

        stableCandidate.hasTriggered = true
        candidate = stableCandidate

        guard let image = makeImage(from: pixelBuffer, orientation: orientation) else {
            return
        }

        // Crop the captured frame to the detected card rectangle before
        // emitting. The reference embedding index was built from tight
        // card-only product shots, so handing the embedder a full camera
        // frame (card-on-desk with lots of background) produced cosine
        // similarities near random (~0.19). Cropping to just the card —
        // with a small padding for edge tolerance — brings the query
        // image's visual statistics back in line with the index.
        let cropResult = croppedToCard(image, observation: stableCandidate.observation)
        let cardImage = cropResult?.image ?? image
        let perspectiveCorrection = cropResult?.diagnostics

        callbackQueue.async { [weak self] in
            guard let self else {
                return
            }

            self.delegate?.didDetectStableCard(
                image: cardImage,
                perspectiveCorrection: perspectiveCorrection,
                triggerKind: "auto",
            )
        }
    }

    /// Crops the captured image down to the Vision-detected card
    /// quadrilateral and unwarps it into a flat axis-aligned card image.
    ///
    /// Tier 1.1 stage 3 (2026-05-07): replaced the previous axis-aligned
    /// bounding-box crop with a full perspective correction using all
    /// four corners of `VNRectangleObservation` (`topLeft`, `topRight`,
    /// `bottomLeft`, `bottomRight`). The bounding-box approach left the
    /// card at whatever angle/skew the user photographed it — when the
    /// phone was held in landscape (Mode 2 in
    /// `scanner-ocr-failure-modes.md`) the cropped image was a
    /// landscape-oriented sideways card, breaking both the OCR's
    /// bottom-region spatial filter AND the embedder's
    /// orientation-sensitive similarity scoring.
    ///
    /// `CIPerspectiveCorrection` flattens any quadrilateral to a
    /// rectangle. The output's dimensions match the input quadrilateral's
    /// long-vs-short edge proportions, so a cleanly-detected portrait
    /// card produces a portrait output and a sideways card produces a
    /// landscape output — at which point we rotate 90° clockwise to
    /// enforce portrait orientation, since Pokemon TCG cards are always
    /// printed taller than wide.
    ///
    /// The 90° rotation can leave the card upside-down ~50% of the
    /// time when the original was sideways (we can't tell the card's
    /// true top from rectangle geometry alone). The OCR pipeline's
    /// pass-2 fallback (Tier 1.1 stage 1) handles the upside-down
    /// case — if the spatial filter rejects card_number-like text at
    /// the image's top, pass-2 admits all observations and the
    /// plausibility filter recovers the digits.
    ///
    /// Returns nil only when the input image has zero size or the
    /// CoreImage filter chain fails (rare). Callers fall back to the
    /// full frame in that case — same contract as the previous
    /// implementation.
    private func croppedToCard(_ image: UIImage, observation: VNRectangleObservation) -> (image: UIImage, diagnostics: PerspectiveCorrectionDiagnostics)? {
        // Step 1: render the input to a flat up-oriented bitmap so the
        // CIImage we wrap doesn't carry residual UIImage.imageOrientation
        // metadata that would skew the corner-coordinate math.
        let orientedSize = image.size
        guard orientedSize.width > 0, orientedSize.height > 0 else { return nil }

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(size: orientedSize, format: format)
        let orientedImage = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: orientedSize))
        }

        guard let cgImage = orientedImage.cgImage else { return nil }

        // Step 2: convert Vision's four normalized corners to pixel
        // coordinates. Vision's normalized space and CIImage's pixel
        // space share the same bottom-left origin convention, so no
        // Y-axis flip is needed — just scale by image dimensions.
        let pixelW = orientedSize.width
        let pixelH = orientedSize.height
        let topLeft = CGPoint(
            x: observation.topLeft.x * pixelW,
            y: observation.topLeft.y * pixelH,
        )
        let topRight = CGPoint(
            x: observation.topRight.x * pixelW,
            y: observation.topRight.y * pixelH,
        )
        let bottomLeft = CGPoint(
            x: observation.bottomLeft.x * pixelW,
            y: observation.bottomLeft.y * pixelH,
        )
        let bottomRight = CGPoint(
            x: observation.bottomRight.x * pixelW,
            y: observation.bottomRight.y * pixelH,
        )

        // Step 3: apply CIPerspectiveCorrection. The filter takes the
        // four corner points and produces a rectangular output where
        // each corner of the input quadrilateral maps to the
        // corresponding corner of the output rectangle.
        let ciImage = CIImage(cgImage: cgImage)
        let filter = CIFilter.perspectiveCorrection()
        filter.inputImage = ciImage
        filter.topLeft = topLeft
        filter.topRight = topRight
        filter.bottomLeft = bottomLeft
        filter.bottomRight = bottomRight

        guard let outputImage = filter.outputImage else { return nil }

        // Note 2026-05-07: an attempted Y-flip on the
        // CIPerspectiveCorrection output (commit b6e18b5) was reverted
        // after real-device evidence showed it horizontally MIRRORED
        // the rendered image rather than vertically flipping it
        // (post-fix setHints came back as `noitzudmo)` for
        // "(Combustion", `92u& noTl` for "Iron Buster" — clear
        // right-to-left text). The intended fix mis-modeled the
        // CIImage / CGImage Y-axis interaction.
        //
        // Phase 0d (2026-05-15): the diagnostic struct returned below
        // captures input corners, output extent, and the step-4
        // rotation flag so each real-device scan now writes the
        // geometry to scan_identify_events.ocr_perspective_corrected_extent
        // (server-routed) and the offline PostHog card_scanned event.
        // Once enough samples land, the Mode 8 fix gets an empirical
        // diagnostic-then-fix pass instead of another mis-modeled
        // coord transform.

        let outputExtent = outputImage.extent

        let context = CIContext(options: nil)
        guard let outputCG = context.createCGImage(outputImage, from: outputExtent) else {
            return nil
        }

        let corrected = UIImage(cgImage: outputCG, scale: 1, orientation: .up)

        // Step 4: enforce portrait orientation. Pokemon TCG cards are
        // always taller than wide. If the perspective-corrected output
        // is wider than tall, the user held the phone in landscape and
        // we need to rotate 90° to make the card upright (or
        // upside-down — see docstring above for the 50/50 rotation
        // ambiguity).
        let portraitRotationApplied = corrected.size.width > corrected.size.height
        let finalImage = portraitRotationApplied
            ? (rotatedClockwise90(corrected) ?? corrected)
            : corrected

        let diagnostics = PerspectiveCorrectionDiagnostics(
            inputCorners: [
                .init(x: Double(topLeft.x), y: Double(topLeft.y)),
                .init(x: Double(topRight.x), y: Double(topRight.y)),
                .init(x: Double(bottomLeft.x), y: Double(bottomLeft.y)),
                .init(x: Double(bottomRight.x), y: Double(bottomRight.y)),
            ],
            outputExtent: .init(
                x: Double(outputExtent.origin.x),
                y: Double(outputExtent.origin.y),
                width: Double(outputExtent.width),
                height: Double(outputExtent.height),
            ),
            inputSize: .init(
                width: Double(orientedSize.width),
                height: Double(orientedSize.height),
            ),
            portraitRotationApplied: portraitRotationApplied,
        )

        return (image: finalImage, diagnostics: diagnostics)
    }

    /// Rotate a UIImage 90° clockwise by setting the orientation flag
    /// to `.right` and then re-rendering into a flat bitmap so the
    /// rotation is baked into the pixels.
    ///
    /// Why bake-then-render rather than just returning the
    /// orientation-tagged UIImage: downstream consumers (Vision
    /// OCR's `VNImageRequestHandler(cgImage:orientation:.up)`, the
    /// embedder's pixel-buffer extraction) read the raw CGImage
    /// pixels and ignore UIImage's orientation flag — they'd see
    /// the image un-rotated. Baking the rotation into the bitmap
    /// makes downstream behavior consistent.
    ///
    /// `UIImage.Orientation.right` means "to display correctly,
    /// rotate the stored pixels 90° clockwise" — exactly what we
    /// want when transforming a landscape-stored card into a
    /// portrait display image. Drawing into a renderer at the
    /// post-rotation size lets UIKit handle the actual pixel
    /// rotation.
    private func rotatedClockwise90(_ image: UIImage) -> UIImage? {
        guard let cgImage = image.cgImage else { return nil }
        let rotated = UIImage(cgImage: cgImage, scale: image.scale, orientation: .right)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(size: rotated.size, format: format)
        return renderer.image { _ in
            rotated.draw(in: CGRect(origin: .zero, size: rotated.size))
        }
    }

    /// One-shot rectangle detection on a single frame. Used by the
    /// tap-to-capture path to give it the same tight, edge-aligned
    /// crop the continuous auto-detect path produces — instead of
    /// the dumb 0.85 center-crop that blindly trims 7.5% off each
    /// edge (and loses the bottom collector-number row when the
    /// card fills the viewfinder).
    ///
    /// Synchronous: blocks the calling thread for ~10-20ms while
    /// VNImageRequestHandler runs a single rectangle pass. Caller
    /// is expected to invoke from a non-main queue or accept the
    /// brief block — tap-to-capture already runs in an async Task,
    /// so this is fine.
    ///
    /// Returns nil when no rectangle is found at the configured
    /// confidence (caller should fall back to a center-crop or the
    /// full frame). Reuses the same configured request the
    /// continuous detection path uses, so tuning stays in one place.
    public func detectAndCrop(_ image: UIImage) -> (image: UIImage, perspectiveCorrection: PerspectiveCorrectionDiagnostics)? {
        guard let cg = image.cgImage else { return nil }

        // Fresh request per call. Sharing rectangleRequest across the
        // continuous and one-shot paths would race on internal state
        // (e.g. regionOfInterest mutated by expireCandidateIfNeeded);
        // creating a new request is microseconds, well below the
        // 10-20ms detection cost.
        let request = makeRectangleRequest()

        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        guard let observations = request.results as? [VNRectangleObservation],
              !observations.isEmpty else {
            return nil
        }

        // Pick the largest observation — same heuristic the continuous
        // path uses (the card is typically the dominant rectangle in
        // the frame; small false positives would have been filtered
        // by `minimumSize` already).
        let best = observations.max {
            ($0.boundingBox.width * $0.boundingBox.height) <
            ($1.boundingBox.width * $1.boundingBox.height)
        }
        guard let observation = best else { return nil }

        guard let cropped = croppedToCard(image, observation: observation) else { return nil }
        return (image: cropped.image, perspectiveCorrection: cropped.diagnostics)
    }

    private func expireCandidateIfNeeded(at timestamp: TimeInterval) {
        guard let candidate else {
            return
        }

        guard timestamp - candidate.lastSeenAt > allowedMissDuration else {
            return
        }

        self.candidate = nil
        self.smoothedPublishedBox = nil
        rectangleRequest.regionOfInterest = Self.fullFrameROI
        notifyCandidateUpdated(nil)
    }

    private func regionOfInterestForCurrentCandidate() -> CGRect {
        guard let candidate else {
            return Self.fullFrameROI
        }

        return candidate.observation.boundingBox
            .insetBy(dx: -0.12, dy: -0.12)
            .clampedToUnitRect()
    }

    private func isCardAspectRatio(_ observation: VNRectangleObservation) -> Bool {
        let ratio = normalizedAspectRatio(for: observation)
        return abs(ratio - expectedCardAspectRatio) <= aspectRatioTolerance
    }

    private func normalizedAspectRatio(for observation: VNRectangleObservation) -> CGFloat {
        let top = distance(from: observation.topLeft, to: observation.topRight)
        let bottom = distance(from: observation.bottomLeft, to: observation.bottomRight)
        let left = distance(from: observation.topLeft, to: observation.bottomLeft)
        let right = distance(from: observation.topRight, to: observation.bottomRight)

        let width = (top + bottom) * 0.5
        let height = (left + right) * 0.5

        guard width > 0, height > 0 else {
            return 0
        }

        return min(width, height) / max(width, height)
    }

    private func matches(
        _ lhs: VNRectangleObservation,
        _ rhs: VNRectangleObservation
    ) -> Bool {
        let iou = intersectionOverUnion(lhs.boundingBox, rhs.boundingBox)
        if iou >= 0.82 {
            return true
        }

        let centerDistance = distance(
            from: CGPoint(x: lhs.boundingBox.midX, y: lhs.boundingBox.midY),
            to: CGPoint(x: rhs.boundingBox.midX, y: rhs.boundingBox.midY)
        )
        let averageCornerDelta = (
            distance(from: lhs.topLeft, to: rhs.topLeft)
                + distance(from: lhs.topRight, to: rhs.topRight)
                + distance(from: lhs.bottomLeft, to: rhs.bottomLeft)
                + distance(from: lhs.bottomRight, to: rhs.bottomRight)
        ) / 4.0

        let aspectRatioDelta = abs(
            normalizedAspectRatio(for: lhs) - normalizedAspectRatio(for: rhs)
        )

        return centerDistance <= 0.035
            && averageCornerDelta <= 0.03
            && aspectRatioDelta <= 0.03
    }

    private func observationScore(_ observation: VNRectangleObservation) -> CGFloat {
        let area = observation.boundingBox.width * observation.boundingBox.height
        let ratioError = abs(normalizedAspectRatio(for: observation) - expectedCardAspectRatio)
        return (CGFloat(observation.confidence) * 2.0) + area - ratioError
    }

    private func makeImage(
        from pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation
    ) -> UIImage? {
        var cgImage: CGImage?
        let status = VTCreateCGImageFromCVPixelBuffer(
            pixelBuffer,
            options: nil,
            imageOut: &cgImage
        )

        guard status == noErr, let cgImage else {
            return nil
        }

        return UIImage(
            cgImage: cgImage,
            scale: 1,
            orientation: UIImage.Orientation(cgImagePropertyOrientation: orientation)
        )
    }

    private func distance(from lhs: CGPoint, to rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }

    private func intersectionOverUnion(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        guard !intersection.isNull else {
            return 0
        }

        let intersectionArea = intersection.width * intersection.height
        let unionArea = (lhs.width * lhs.height) + (rhs.width * rhs.height) - intersectionArea

        guard unionArea > 0 else {
            return 0
        }

        return intersectionArea / unionArea
    }

    private static let fullFrameROI = CGRect(x: 0, y: 0, width: 1, height: 1)
}

private struct StableCandidate {
    var observation: VNRectangleObservation
    var firstSeenAt: TimeInterval
    var lastSeenAt: TimeInterval
    var hasTriggered: Bool
}

/// In-progress saliency observation accumulating stability across
/// frames. Distinct from `StableCandidate` because the saliency
/// detector returns axis-aligned `boundingBox`-only observations
/// (no corner points), and the stability predicate uses IoU rather
/// than the rectangle path's corner-distance check.
private struct SalientCandidate {
    var boundingBox: CGRect
    var firstSeenAt: TimeInterval
    var lastSeenAt: TimeInterval
    var hasTriggered: Bool
}

private extension CGRect {
    func clampedToUnitRect() -> CGRect {
        let minX = Swift.max(0, origin.x)
        let minY = Swift.max(0, origin.y)
        let maxX = Swift.min(1, origin.x + size.width)
        let maxY = Swift.min(1, origin.y + size.height)

        guard maxX > minX, maxY > minY else {
            return CGRect(x: 0, y: 0, width: 1, height: 1)
        }

        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

private extension UIImage.Orientation {
    init(cgImagePropertyOrientation: CGImagePropertyOrientation) {
        switch cgImagePropertyOrientation {
        case .up:
            self = .up
        case .upMirrored:
            self = .upMirrored
        case .down:
            self = .down
        case .downMirrored:
            self = .downMirrored
        case .left:
            self = .left
        case .leftMirrored:
            self = .leftMirrored
        case .right:
            self = .right
        case .rightMirrored:
            self = .rightMirrored
        @unknown default:
            self = .up
        }
    }
}
