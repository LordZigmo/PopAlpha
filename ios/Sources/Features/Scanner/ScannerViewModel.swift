import Combine
import UIKit

@available(iOS 17.0, *)
@MainActor
public final class ScannerViewModel: ObservableObject, PopAlphaVisionEngineDelegate {
    @Published public private(set) var recognizedCardID: String?
    @Published public private(set) var isScanning = true

    public let visionEngine: PopAlphaVisionEngine

    private let classifier: PopAlphaCardClassifier
    private var identificationTask: Task<Void, Never>?

    public init(bundle: Bundle = .main) throws {
        self.visionEngine = PopAlphaVisionEngine()
        self.classifier = try PopAlphaCardClassifier(bundle: bundle)
        self.visionEngine.delegate = self
    }

    deinit {
        identificationTask?.cancel()
    }

    public func resumeScanning() {
        identificationTask?.cancel()
        identificationTask = nil
        recognizedCardID = nil
        isScanning = true
        visionEngine.reset()
    }

    public nonisolated func didDetectStableCard(image: UIImage) {
        Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            guard self.isScanning, self.identificationTask == nil else {
                return
            }

            self.isScanning = false
            self.identificationTask = Task { @MainActor [weak self] in
                guard let self else {
                    return
                }

                defer {
                    self.identificationTask = nil
                }

                do {
                    let cardID = try await self.classifier.identifyCard(in: image)
                    guard !Task.isCancelled else {
                        return
                    }

                    self.recognizedCardID = cardID
                    self.isScanning = false
                } catch {
                    guard !Task.isCancelled else {
                        return
                    }

                    self.recognizedCardID = nil
                    self.isScanning = true
                    self.visionEngine.reset()
                }
            }
        }
    }
}
