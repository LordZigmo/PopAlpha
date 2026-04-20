import Foundation
import UIKit

// MARK: - Language toggle

enum ScanLanguage: String, CaseIterable, Sendable {
    case en = "EN"
    case jp = "JP"

    var displayName: String {
        switch self {
        case .en: return "English"
        case .jp: return "Japanese"
        }
    }

    var shortLabel: String {
        switch self {
        case .en: return "EN"
        case .jp: return "JP"
        }
    }
}

// MARK: - Response shape (mirrors /api/scan/identify)

struct ScanMatch: Decodable, Sendable, Equatable {
    let slug: String
    let canonicalName: String
    let language: String?
    let setName: String?
    let cardNumber: String?
    let variant: String?
    let mirroredPrimaryImageUrl: String?
    let similarity: Double
}

struct ScanIdentifyResponse: Decodable, Sendable {
    let ok: Bool
    let confidence: String  // "high" | "medium" | "low"
    let matches: [ScanMatch]
    let languageFilter: String
    let modelVersion: String

    var topMatch: ScanMatch? { matches.first }
    var isHighConfidence: Bool { confidence == "high" }
    var isMediumConfidence: Bool { confidence == "medium" }
}

// MARK: - Service

enum ScanService {
    /// Identifies a card from a captured frame against the server-side
    /// embedding index. The image is resized to ~768px long-edge and
    /// JPEG-compressed (q=0.8) before upload — target body size is
    /// ~60–100 KB, which uploads in ~200ms over LTE.
    static func identify(
        image: UIImage,
        language: ScanLanguage,
        maxEdgePixels: CGFloat = 768,
        compressionQuality: CGFloat = 0.8
    ) async throws -> ScanIdentifyResponse {
        guard let jpegData = resizedJPEG(
            from: image,
            maxEdge: maxEdgePixels,
            quality: compressionQuality
        ) else {
            throw ScanServiceError.imageEncodingFailed
        }

        return try await APIClient.postRaw(
            path: "/api/scan/identify",
            body: jpegData,
            contentType: "image/jpeg",
            query: [("language", language.rawValue)]
        )
    }

    /// Re-encodes a UIImage as a downsized JPEG. Returns nil on zero-sized
    /// input. Always renders at scale 1 so a Retina-captured image
    /// doesn't smuggle 3x pixel density into the payload.
    private static func resizedJPEG(
        from image: UIImage,
        maxEdge: CGFloat,
        quality: CGFloat
    ) -> Data? {
        let longEdge = max(image.size.width, image.size.height)
        guard longEdge > 0 else { return nil }

        let scale = longEdge > maxEdge ? maxEdge / longEdge : 1.0
        let target = CGSize(
            width: image.size.width * scale,
            height: image.size.height * scale
        )

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }
}

enum ScanServiceError: LocalizedError {
    case imageEncodingFailed

    var errorDescription: String? {
        switch self {
        case .imageEncodingFailed:
            return "Failed to encode captured image for upload."
        }
    }
}
