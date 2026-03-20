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
        isScanning = true
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
            self?.startIdentification(with: image)
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
