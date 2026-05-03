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
    /// sha256 of the uploaded JPEG bytes, computed server-side. Threaded
    /// through so CardDetailView can hand this back to the promote
    /// endpoint when the user reports a mis-identification — server then
    /// copies scan-uploads/<hash>.jpg into scan-eval/<hash>.jpg.
    let imageHash: String?
    /// Day 2 retrieval path (`vision_only`, `ocr_direct_unique`,
    /// `ocr_direct_narrow`, `ocr_intersect_unique`,
    /// `ocr_intersect_narrow`). Surfaced in the DEBUG overlay so the
    /// operator can see which signal resolved each scan. Nullable
    /// because pre-Day-2 server builds didn't send it; current
    /// production always emits a value.
    let winningPath: String?

    var topMatch: ScanMatch? { matches.first }
    var isHighConfidence: Bool { confidence == "high" }
    var isMediumConfidence: Bool { confidence == "medium" }
}

// MARK: - Promote-to-eval response

struct ScanEvalPromoteResponse: Decodable, Sendable {
    let ok: Bool
    let evalImageId: String?
    let storagePath: String?
    let imageHash: String?
    let imageBytesSize: Int?
    let canonicalSlug: String?
    let wasUpload: Bool?
    let error: String?
}

// MARK: - User-correction response (anchor-only flow)

/// Returned by /api/scan/correction. Pure kNN-anchor path — no
/// scan_eval_images write, no curated-corpus side effect. Distinct
/// from ScanEvalPromoteResponse which is the admin-gated eval-corpus
/// promote endpoint's shape.
struct ScanCorrectionResponse: Decodable, Sendable {
    let ok: Bool
    let imageHash: String?
    let modelVersion: String?
    let variantIndex: Int?
    let skipped: Bool?
    let error: String?
}

/// Which seeding path the user took. Feeds into scan_eval_images.captured_source
/// so corrections show up distinctly from "I manually labeled a photo."
enum EvalCaptureSource: String, Sendable {
    case userPhoto = "user_photo"
    case userCorrection = "user_correction"
}

// MARK: - Service

enum ScanService {
    /// Identifies a card from a captured frame against the server-side
    /// embedding index. The image is resized to ~768px long-edge and
    /// JPEG-compressed (q=0.8) before upload — target body size is
    /// ~60–100 KB, which uploads in ~200ms over LTE.
    ///
    /// `cardNumber` is the on-device OCR result (from
    /// `OCRService.extractCollectorNumber`). When supplied, the server
    /// narrows kNN candidates to canonical_cards rows whose
    /// `card_number` matches — structurally resolves variant
    /// confusion (V vs VMAX vs ex), reprint ambiguity (Base vs Base
    /// Set 2), and lighthouse pull (Samurott VSTAR magneting other
    /// holographic-foil cards) that CLIP alone can't separate.
    /// Server falls back gracefully if the filter drops all candidates
    /// (OCR was wrong / canonical_cards.card_number is stale), so
    /// passing this value can never make a scan worse than not
    /// passing it.
    static func identify(
        image: UIImage,
        language: ScanLanguage,
        cardNumber: String? = nil,
        setHint: String? = nil,
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

        var query: [(String, String)] = [("language", language.rawValue)]
        if let cardNumber, !cardNumber.isEmpty {
            query.append(("card_number", cardNumber))
        }
        if let setHint, !setHint.isEmpty {
            query.append(("set_hint", setHint))
        }

        return try await APIClient.postRaw(
            path: "/api/scan/identify",
            body: jpegData,
            contentType: "image/jpeg",
            query: query
        )
    }

    /// Promotes a past scan (identified by its image_hash) into the eval
    /// corpus with the user-provided correct canonical_slug. Use from
    /// CardDetailView when the user reports a mis-identification —
    /// server copies scan-uploads/<hash>.jpg into scan-eval/<hash>.jpg.
    static func promoteEvalFromHash(
        imageHash: String,
        canonicalSlug: String,
        source: EvalCaptureSource = .userCorrection,
        language: ScanLanguage = .en,
        notes: String? = nil
    ) async throws -> ScanEvalPromoteResponse {
        var body: [String: Any] = [
            "canonical_slug": canonicalSlug,
            "image_hash": imageHash,
            "captured_source": source.rawValue,
            "captured_language": language.rawValue,
        ]
        if let notes, !notes.isEmpty { body["notes"] = notes }

        return try await APIClient.post(
            path: "/api/admin/scan-eval/promote",
            body: body
        )
    }

    /// User-gated correction. Posts the offline-scan JPEG bytes + the
    /// corrected canonical_slug to /api/scan/correction, which creates
    /// a `user_correction` kNN anchor in the SAME embedding space as
    /// the offline catalog. Next sync of the offline catalog picks it
    /// up so subsequent scans of visually-similar cards resolve
    /// correctly.
    ///
    /// Distinct from `promoteEvalFromBytes`/`promoteEvalFromHash`:
    /// those hit /api/admin/scan-eval/promote which writes to
    /// scan_eval_images (curated training corpus, admin-only). This
    /// hits /api/scan/correction which is user-gated and ONLY writes
    /// the kNN anchor — the right path for non-admin premium users
    /// reporting a wrong scan from the picker.
    ///
    /// `skipped: true` means the same (slug, image_hash, model) was
    /// already an anchor — idempotent re-submit, harmless.
    static func submitCorrection(
        image: UIImage,
        canonicalSlug: String,
        language: ScanLanguage = .en,
        notes: String? = nil,
        maxEdgePixels: CGFloat = 1024,
        compressionQuality: CGFloat = 0.85,
    ) async throws -> ScanCorrectionResponse {
        guard let jpegData = resizedJPEG(
            from: image,
            maxEdge: maxEdgePixels,
            quality: compressionQuality,
        ) else {
            throw ScanServiceError.imageEncodingFailed
        }
        var body: [String: Any] = [
            "canonical_slug": canonicalSlug,
            "image_base64": jpegData.base64EncodedString(),
            "language": language.rawValue,
        ]
        if let notes, !notes.isEmpty { body["notes"] = notes }
        return try await APIClient.post(
            path: "/api/scan/correction",
            body: body,
        )
    }

    /// Promotes a freshly-picked photo into the eval corpus as ground
    /// truth — no prior scan required. Base64-encodes the JPEG into a
    /// JSON body so we don't need multipart plumbing on the client.
    static func promoteEvalFromBytes(
        image: UIImage,
        canonicalSlug: String,
        source: EvalCaptureSource = .userPhoto,
        language: ScanLanguage = .en,
        notes: String? = nil,
        maxEdgePixels: CGFloat = 1024,
        compressionQuality: CGFloat = 0.85
    ) async throws -> ScanEvalPromoteResponse {
        guard let jpegData = resizedJPEG(
            from: image,
            maxEdge: maxEdgePixels,
            quality: compressionQuality
        ) else {
            throw ScanServiceError.imageEncodingFailed
        }

        var body: [String: Any] = [
            "canonical_slug": canonicalSlug,
            "image_base64": jpegData.base64EncodedString(),
            "captured_source": source.rawValue,
            "captured_language": language.rawValue,
        ]
        if let notes, !notes.isEmpty { body["notes"] = notes }

        return try await APIClient.post(
            path: "/api/admin/scan-eval/promote",
            body: body
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
