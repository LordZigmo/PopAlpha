import AVFoundation
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreML
import ImageIO
import UIKit
import VideoToolbox
import Vision

public protocol PopAlphaVisionEngineDelegate: AnyObject {
    func didDetectStableCard(image: UIImage)

    /// Fires every frame that the engine has a live candidate rectangle, and
    /// with `nil` when the candidate expires. Bounding box is in Vision's
    /// normalized coordinate space (origin bottom-left, 0–1 range).
    /// Default implementation is a no-op so existing conformers don't break.
    func didUpdateCandidateBoundingBox(_ normalizedBoundingBox: CGRect?)
}

public extension PopAlphaVisionEngineDelegate {
    func didUpdateCandidateBoundingBox(_ normalizedBoundingBox: CGRect?) {}
}

public final class PopAlphaVisionEngine {
    public weak var delegate: PopAlphaVisionEngineDelegate?

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

        do {
            let requestHandler = VNImageRequestHandler(
                cvPixelBuffer: pixelBuffer,
                orientation: orientation,
                options: [:]
            )

            try requestHandler.perform([rectangleRequest])

            let observation = bestCardObservation(from: rectangleRequest.results ?? [])
            updateCandidate(
                with: observation,
                at: timestamp,
                pixelBuffer: pixelBuffer,
                orientation: orientation
            )
        } catch {
            expireCandidateIfNeeded(at: timestamp)
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

    private func configurePreferredComputeDevices(for request: VNDetectRectanglesRequest) {
        guard #available(iOS 17.0, *) else {
            return
        }

        guard let supportedDevices = try? request.supportedComputeStageDevices else {
            return
        }

        for (stage, devices) in supportedDevices {
            if let neuralEngine = devices.first(where: {
                if case .neuralEngine = $0 {
                    return true
                }

                return false
            }) {
                request.setComputeDevice(neuralEngine, for: stage)
                continue
            }

            if let gpu = devices.first(where: {
                if case .gpu = $0 {
                    return true
                }

                return false
            }) {
                request.setComputeDevice(gpu, for: stage)
            }
        }
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
        let cardImage = croppedToCard(image, observation: stableCandidate.observation) ?? image

        callbackQueue.async { [weak self] in
            guard let self else {
                return
            }

            self.delegate?.didDetectStableCard(image: cardImage)
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
    private func croppedToCard(_ image: UIImage, observation: VNRectangleObservation) -> UIImage? {
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

        let context = CIContext(options: nil)
        guard let outputCG = context.createCGImage(outputImage, from: outputImage.extent) else {
            return nil
        }

        let corrected = UIImage(cgImage: outputCG, scale: 1, orientation: .up)

        // Step 4: enforce portrait orientation. Pokemon TCG cards are
        // always taller than wide. If the perspective-corrected output
        // is wider than tall, the user held the phone in landscape and
        // we need to rotate 90° to make the card upright (or
        // upside-down — see docstring above for the 50/50 rotation
        // ambiguity).
        if corrected.size.width > corrected.size.height {
            return rotatedClockwise90(corrected) ?? corrected
        }
        return corrected
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
    public func detectAndCrop(_ image: UIImage) -> UIImage? {
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

        return croppedToCard(image, observation: observation)
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
