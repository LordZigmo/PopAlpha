import CoreImage
import CoreML
import ImageIO
import UIKit

public enum PopAlphaCardClassifierError: LocalizedError {
    case modelNotFound(String)
    case unsupportedInput([String])
    case invalidImageInput(String)
    case failedToCreateCGImage
    case unsupportedOutput([String])
    case cardIDNotFound([String])

    public var errorDescription: String? {
        switch self {
        case let .modelNotFound(name):
            return "Unable to find \(name).mlmodelc in the supplied bundle."
        case let .unsupportedInput(inputs):
            return "The model does not expose a supported image input. Inputs: \(inputs.joined(separator: ", "))."
        case let .invalidImageInput(name):
            return "The model rejected the image input for feature '\(name)'."
        case .failedToCreateCGImage:
            return "Unable to build a CGImage from the provided UIImage."
        case let .unsupportedOutput(outputs):
            return "The model output could not be mapped to a CardID. Outputs: \(outputs.joined(separator: ", "))."
        case let .cardIDNotFound(outputs):
            return "The model ran successfully but did not yield a CardID. Outputs: \(outputs.joined(separator: ", "))."
        }
    }
}

@available(iOS 17.0, *)
public final class PopAlphaCardClassifier {
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let modelStore: ModelStore

    public init(
        bundle: Bundle = .main,
        modelName: String = "PopAlphaRFDETR"
    ) throws {
        guard let modelURL = bundle.url(forResource: modelName, withExtension: "mlmodelc") else {
            throw PopAlphaCardClassifierError.modelNotFound(modelName)
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        configuration.modelDisplayName = "PopAlpha Card Classifier"

        self.modelStore = ModelStore(modelURL: modelURL, configuration: configuration)
    }

    public func identifyCard(in image: UIImage) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let model = try await self.modelStore.model()
            let input = try self.makeInputProvider(from: image, model: model)
            let output = try await model.prediction(from: input)
            return try self.resolveCardID(from: output, model: model)
        }.value
    }

    public func identifyCard(
        in image: UIImage,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        Task(priority: .userInitiated) {
            do {
                let cardID = try await self.identifyCard(in: image)
                completion(.success(cardID))
            } catch {
                completion(.failure(error))
            }
        }
    }

    private func resolveCardID(
        from output: any MLFeatureProvider,
        model: MLModel
    ) throws -> String {
        if let predictedFeatureName = model.modelDescription.predictedFeatureName,
           let featureValue = output.featureValue(for: predictedFeatureName),
           let cardID = extractCardID(
               from: featureValue,
               featureName: predictedFeatureName,
               classLabels: model.modelDescription.classLabels
           ) {
            return cardID
        }

        if let probabilitiesName = model.modelDescription.predictedProbabilitiesName,
           let featureValue = output.featureValue(for: probabilitiesName),
           let cardID = bestDictionaryLabel(from: featureValue.dictionaryValue) {
            return cardID
        }

        for featureName in prioritizedFeatureNames(output.featureNames) {
            guard let featureValue = output.featureValue(for: featureName) else {
                continue
            }

            if let cardID = extractCardID(
                from: featureValue,
                featureName: featureName,
                classLabels: model.modelDescription.classLabels
            ) {
                return cardID
            }
        }

        throw PopAlphaCardClassifierError.cardIDNotFound(Array(output.featureNames).sorted())
    }

    private func makeInputProvider(
        from image: UIImage,
        model: MLModel
    ) throws -> MLFeatureProvider {
        guard let (featureName, featureDescription) = imageInputDescription(
            from: model.modelDescription.inputDescriptionsByName
        ) else {
            throw PopAlphaCardClassifierError.unsupportedInput(
                Array(model.modelDescription.inputDescriptionsByName.keys).sorted()
            )
        }

        guard let imageConstraint = featureDescription.imageConstraint else {
            throw PopAlphaCardClassifierError.unsupportedInput(
                Array(model.modelDescription.inputDescriptionsByName.keys).sorted()
            )
        }

        guard let cgImage = makeCGImage(from: image) else {
            throw PopAlphaCardClassifierError.failedToCreateCGImage
        }

        let featureValue = try MLFeatureValue(
            cgImage: cgImage,
            orientation: CGImagePropertyOrientation(image.imageOrientation),
            constraint: imageConstraint,
            options: nil
        )

        guard featureDescription.isAllowedValue(featureValue) else {
            throw PopAlphaCardClassifierError.invalidImageInput(featureName)
        }

        return try MLDictionaryFeatureProvider(dictionary: [featureName: featureValue])
    }

    private func imageInputDescription(
        from inputs: [String: MLFeatureDescription]
    ) -> (String, MLFeatureDescription)? {
        if let preferred = inputs.first(where: {
            $0.value.type == .image && $0.key.lowercased().contains("image")
        }) {
            return preferred
        }

        return inputs.first(where: { $0.value.type == .image })
    }

    private func prioritizedFeatureNames(_ featureNames: Set<String>) -> [String] {
        featureNames.sorted { lhs, rhs in
            priorityScore(for: lhs) > priorityScore(for: rhs)
        }
    }

    private func priorityScore(for featureName: String) -> Int {
        let normalized = featureName.lowercased()

        if normalized.contains("cardid") || normalized.contains("card_id") {
            return 5
        }

        if normalized.contains("label") {
            return 4
        }

        if normalized.contains("class") {
            return 3
        }

        if normalized.contains("id") {
            return 2
        }

        return 1
    }

    private func extractCardID(
        from featureValue: MLFeatureValue,
        featureName: String,
        classLabels: [Any]?
    ) -> String? {
        if featureValue.type == .string {
            let stringValue = featureValue.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !stringValue.isEmpty else {
                return nil
            }

            return stringValue
        }

        if featureValue.type == .int64 {
            let rawIndex = Int(featureValue.int64Value)
            if let classLabel = classLabel(at: rawIndex, labels: classLabels) {
                return classLabel
            }

            return String(rawIndex)
        }

        if featureValue.type == .double {
            let rawValue = featureValue.doubleValue
            let asIndex = Int(rawValue.rounded())
            if let classLabel = classLabel(at: asIndex, labels: classLabels) {
                return classLabel
            }

            return String(asIndex)
        }

        if featureValue.type == .dictionary,
           let label = bestDictionaryLabel(from: featureValue.dictionaryValue) {
            return label
        }

        if featureValue.type == .multiArray,
           let multiArray = featureValue.multiArrayValue,
           let bestIndex = argMaxIndex(in: multiArray) {
            if let classLabel = classLabel(at: bestIndex, labels: classLabels) {
                return classLabel
            }

            if featureName.lowercased().contains("card") || featureName.lowercased().contains("label") {
                return String(bestIndex)
            }
        }

        return nil
    }

    private func classLabel(at index: Int, labels: [Any]?) -> String? {
        guard let labels, labels.indices.contains(index) else {
            return nil
        }

        if let stringLabel = labels[index] as? String {
            return stringLabel
        }

        if let numberLabel = labels[index] as? NSNumber {
            return numberLabel.stringValue
        }

        return nil
    }

    private func bestDictionaryLabel(from dictionary: [AnyHashable: NSNumber]) -> String? {
        let bestEntry = dictionary.max { lhs, rhs in
            lhs.value.doubleValue < rhs.value.doubleValue
        }

        if let stringKey = bestEntry?.key as? String {
            return stringKey
        }

        if let numberKey = bestEntry?.key as? NSNumber {
            return numberKey.stringValue
        }

        return nil
    }

    private func argMaxIndex(in multiArray: MLMultiArray) -> Int? {
        let count = multiArray.count
        guard count > 0 else {
            return nil
        }

        switch multiArray.dataType {
        case .double:
            let values = multiArray.dataPointer.bindMemory(to: Double.self, capacity: count)
            return argMaxIndex(count: count) { index in values[index] }
        case .float32:
            let values = multiArray.dataPointer.bindMemory(to: Float.self, capacity: count)
            return argMaxIndex(count: count) { index in Double(values[index]) }
        case .float16:
            let values = multiArray.dataPointer.bindMemory(to: UInt16.self, capacity: count)
            return argMaxIndex(count: count) { index in
                Double(Float16(bitPattern: values[index]))
            }
        case .int32:
            let values = multiArray.dataPointer.bindMemory(to: Int32.self, capacity: count)
            return argMaxIndex(count: count) { index in Double(values[index]) }
        case .int8:
            if #available(iOS 26.0, *) {
                let values = multiArray.dataPointer.bindMemory(to: Int8.self, capacity: count)
                return argMaxIndex(count: count) { index in Double(values[index]) }
            }

            return nil
        @unknown default:
            return nil
        }
    }

    private func argMaxIndex(
        count: Int,
        valueAt: (Int) -> Double
    ) -> Int? {
        guard count > 0 else {
            return nil
        }

        var bestIndex = 0
        var bestValue = valueAt(0)

        for index in 1..<count {
            let value = valueAt(index)
            if value > bestValue {
                bestValue = value
                bestIndex = index
            }
        }

        return bestIndex
    }

    private func makeCGImage(from image: UIImage) -> CGImage? {
        if let cgImage = image.cgImage {
            return cgImage
        }

        if let ciImage = image.ciImage {
            return ciContext.createCGImage(ciImage, from: ciImage.extent)
        }

        let rendererFormat = UIGraphicsImageRendererFormat.default()
        rendererFormat.scale = 1
        rendererFormat.opaque = false

        let renderer = UIGraphicsImageRenderer(size: image.size, format: rendererFormat)
        let renderedImage = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }

        return renderedImage.cgImage
    }
}

private actor ModelStore {
    private let modelURL: URL
    private let configuration: MLModelConfiguration

    private var loadedModel: MLModel?
    private var loadTask: Task<MLModel, Error>?

    init(modelURL: URL, configuration: MLModelConfiguration) {
        self.modelURL = modelURL
        self.configuration = configuration
    }

    func model() async throws -> MLModel {
        if let loadedModel {
            return loadedModel
        }

        if let loadTask {
            return try await loadTask.value
        }

        let task = Task<MLModel, Error> {
            try await MLModel.load(contentsOf: modelURL, configuration: configuration)
        }

        loadTask = task

        do {
            let model = try await task.value
            loadedModel = model
            loadTask = nil
            return model
        } catch {
            loadTask = nil
            throw error
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
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
