import AVFoundation
import CoreGraphics
import CoreML
import ImageIO
import UIKit
import VideoToolbox
import Vision

public protocol PopAlphaVisionEngineDelegate: AnyObject {
    func didDetectStableCard(image: UIImage)
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

    public init(
        delegate: PopAlphaVisionEngineDelegate? = nil,
        callbackQueue: DispatchQueue = .main,
        minimumStableDuration: TimeInterval = 0.5,
        aspectRatioTolerance: CGFloat = 0.08,
        minimumCardSize: CGFloat = 0.18,
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
            self.rectangleRequest.regionOfInterest = Self.fullFrameROI
        }
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
        request.revision = VNDetectRectanglesRequestRevision1
        request.preferBackgroundProcessing = false
        request.minimumConfidence = 0.75
        request.minimumSize = Float(minimumCardSize)
        request.minimumAspectRatio = Float(max(0.0, expectedCardAspectRatio - aspectRatioTolerance))
        request.maximumAspectRatio = Float(min(1.0, expectedCardAspectRatio + aspectRatioTolerance))
        request.quadratureTolerance = 18
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
            candidate = StableCandidate(
                observation: observation,
                firstSeenAt: timestamp,
                lastSeenAt: timestamp,
                hasTriggered: false
            )
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

        callbackQueue.async { [weak self] in
            guard let self else {
                return
            }

            self.delegate?.didDetectStableCard(image: image)
        }
    }

    private func expireCandidateIfNeeded(at timestamp: TimeInterval) {
        guard let candidate else {
            return
        }

        guard timestamp - candidate.lastSeenAt > allowedMissDuration else {
            return
        }

        self.candidate = nil
        rectangleRequest.regionOfInterest = Self.fullFrameROI
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
