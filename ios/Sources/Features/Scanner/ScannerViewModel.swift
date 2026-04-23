import Combine
import Foundation
import UIKit

public enum ScannerViewModelError: LocalizedError {
    case missingCapturedImage
    case mockCardsUnavailable

    public var errorDescription: String? {
        switch self {
        case .missingCapturedImage:
            return "A captured image is required when simulator mode is disabled."
        case .mockCardsUnavailable:
            return "Simulator mode is enabled, but no mock cards are available."
        }
    }
}

@available(iOS 17.0, *)
@MainActor
public final class ScannerViewModel: ObservableObject, PopAlphaVisionEngineDelegate {
    @Published public private(set) var recognizedCard: PopAlphaCard?
    @Published public private(set) var debugIndexLabel: String?
    @Published public private(set) var isScanning = true
    @Published public var useMockData: Bool

    /// Vision-normalized bounding box of the current live candidate (origin bottom-left, 0–1 range),
    /// or nil when the engine has no active candidate. Updated every frame the candidate is visible.
    @Published public private(set) var candidateBoundingBox: CGRect?

    /// Installed by `ScannerCameraViewController` after its preview layer lays out.
    /// Converts a Vision-normalized bounding box to view-space coordinates via
    /// `AVCaptureVideoPreviewLayer.layerRectConverted(fromMetadataOutputRect:)`,
    /// handling rotation + aspectFill crop. Nil on simulator (no camera).
    public var normalizedRectConverter: ((CGRect) -> CGRect?)?

    /// Hook the app layer installs to replace the on-device CoreML
    /// classifier with a network identifier (e.g. /api/scan/identify).
    /// When non-nil, the stability-gated captured UIImage is handed to
    /// this closure and the internal classifier path is skipped.
    /// ScannerViewModel pauses scanning while the closure runs; the app
    /// must call `resumeScanning()` when it's ready for the next scan
    /// (low-confidence result, user retry, or post-navigation dismiss).
    public var onStableCardCaptured: (@Sendable (UIImage) async -> Void)?

    public let visionEngine: PopAlphaVisionEngine
    public var recognizedCardID: String? { recognizedCard?.id }
    public var simulatorTaskID: String { "\(useMockData)-\(isScanning)-\(recognizedCard?.id ?? "nil")" }

    private let bundle: Bundle
    private var classifier: PopAlphaCardClassifier?
    private let cardCatalog: PopAlphaCardCatalog
    private let labelMapper: LabelMapper
    private var identificationTask: Task<Void, Never>?

    public init(
        bundle: Bundle = ScannerResourceBundle.bundle,
        useMockData: Bool = false
    ) throws {
        self.bundle = bundle
        self.useMockData = useMockData
        self.visionEngine = PopAlphaVisionEngine()
        self.cardCatalog = try PopAlphaCardCatalog(bundle: bundle)
        self.labelMapper = LabelMapper(cardCatalog: cardCatalog)
        self.classifier = useMockData ? nil : try PopAlphaCardClassifier(bundle: bundle)
        self.visionEngine.delegate = self
    }

    deinit {
        identificationTask?.cancel()
    }

    public func resumeScanning() {
        identificationTask?.cancel()
        identificationTask = nil
        recognizedCard = nil
        debugIndexLabel = nil
        candidateBoundingBox = nil
        isScanning = true
        visionEngine.reset()
    }

    /// Pauses the Vision stability gate so the app layer can identify
    /// a UIImage it sourced from somewhere other than the live camera
    /// (e.g. a photo-library pick). Mirrors the isScanning=false branch
    /// of `didDetectStableCard` without requiring a captured frame.
    /// Call `resumeScanning()` when you're ready for the live camera
    /// path to fire again.
    public func pauseForExternalCapture() {
        identificationTask?.cancel()
        identificationTask = nil
        isScanning = false
        candidateBoundingBox = nil
        visionEngine.reset()
    }

    public func triggerMockDetection() {
        guard useMockData else {
            return
        }

        startIdentification(with: nil)
    }

    public nonisolated func didDetectStableCard(image: UIImage) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let hook = self.onStableCardCaptured {
                // App-level identifier installed — skip the CoreML path
                // and hand the captured frame to the network identifier.
                // Pause scanning for the duration so the Vision engine
                // stops re-triggering while the network call is inflight.
                self.isScanning = false
                self.visionEngine.reset()
                await hook(image)
            } else {
                self.startIdentification(with: image)
            }
        }
    }

    public nonisolated func didUpdateCandidateBoundingBox(_ normalizedBoundingBox: CGRect?) {
        Task { @MainActor [weak self] in
            self?.candidateBoundingBox = normalizedBoundingBox
        }
    }

    private func startIdentification(with image: UIImage?) {
        guard isScanning, identificationTask == nil else {
            return
        }

        isScanning = false
        identificationTask = Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            defer {
                self.identificationTask = nil
            }

            do {
                let result = try await self.resolveDetectedCard(from: image)
                guard !Task.isCancelled else {
                    return
                }

                self.recognizedCard = result.card
                self.debugIndexLabel = result.debugIndexLabel
                self.isScanning = false
            } catch {
                guard !Task.isCancelled else {
                    return
                }

                self.recognizedCard = nil
                self.debugIndexLabel = nil
                self.isScanning = true
                self.visionEngine.reset()
            }
        }
    }

    private func resolveDetectedCard(from image: UIImage?) async throws -> LabelMappingResult {
        if useMockData {
            return labelMapper.mapModelOutput("pokemon_card")
        }

        guard let image else {
            throw ScannerViewModelError.missingCapturedImage
        }

        let classifier = try resolveClassifier()
        let detectedLabel = try await classifier.identifyCard(in: image)
        return labelMapper.mapModelOutput(detectedLabel)
    }

    private func resolveClassifier() throws -> PopAlphaCardClassifier {
        if let classifier {
            return classifier
        }

        let classifier = try PopAlphaCardClassifier(bundle: bundle)
        self.classifier = classifier
        return classifier
    }
}
