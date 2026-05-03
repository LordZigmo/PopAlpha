// OfflineScanOrchestrator.swift
//
// Bridges `PopAlphaCore`'s offline trilogy (catalog/embedder/kNN/
// identifier) to the `ScanIdentifyResponse` shape the iOS UI was
// already wired to consume from the server. Lets `ScannerHost.runIdentify`
// flip between online + offline paths with a single boolean.
//
// LIFECYCLE:
//
//   - `setupTask` lazily downloads the catalog (via OfflineCatalogManager)
//     and instantiates OfflineEmbedder + OfflineKNN + OfflineIdentifier.
//     Awaitable so the caller (premium-activation flow, scanner start)
//     can show progress UI.
//
//   - `identify(image:cardNumber:setHint:language:)` runs the full
//     embed→identify pipeline on a background priority and returns
//     a `ScanIdentifyResponse` matching the network contract.
//
//   - On any setup failure (no catalog, model load failed, embedder
//     errored), `identify` throws `OfflineScanOrchestratorError` so
//     the caller can fall back to online identify without trying to
//     interpret what went wrong.
//
// FALLBACK MODEL:
//
//   The scanner UI's existing `runIdentify` path catches errors and
//   re-arms the camera. We keep the orchestrator's failure surface
//   small (one error type, one message) so the existing error UI
//   handles it without offline-specific branches.
//
// METADATA GAPS:
//
//   The .papb format v2 stores: slug, set_name, card_number, language,
//   variant_index, source. It does NOT carry canonical_name or
//   mirrored_primary_image_url, both of which `ScanMatch` exposes
//   for the picker UI + card detail view. Two stopgaps:
//
//     1. canonical_name → derived from slug by stripping the
//        `set-slug-cardnumber-` prefix and title-casing the remainder.
//        Pretty good for ~95% of cards (the slug encodes the name
//        in a deterministic way the canonicalize step generates).
//
//     2. mirroredPrimaryImageUrl → built from the canonical
//        Supabase Storage path: `card-images/canonical/<slug>/full.png`.
//        Identical to the URL the server route returns, so card
//        detail's image cache works seamlessly.
//
//   When we bump the .papb format to v3 (adding name + image_url
//   columns), these fallbacks become exact.

import Foundation
import UIKit
import CryptoKit
import PopAlphaCore

public enum OfflineScanOrchestratorError: Error, LocalizedError {
    case notReady
    case setupFailed(String)
    case embedderFailed(String)
    case identifyFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notReady: return "Offline scanner is still preparing. Try again in a moment."
        case .setupFailed(let m): return "Offline scanner setup failed: \(m)"
        case .embedderFailed(let m): return "On-device embedder failed: \(m)"
        case .identifyFailed(let m): return "On-device identify failed: \(m)"
        }
    }
}

@MainActor
final class OfflineScanOrchestrator: ObservableObject {

    // MARK: - Public state

    @Published private(set) var setupState: SetupState = .idle

    enum SetupState: Equatable {
        case idle
        case preparing(message: String)
        case ready
        case failed(message: String)
    }

    // MARK: - Internal state

    private let manager: OfflineCatalogManager
    private let anchorStore: OfflineCatalogAnchorStore
    private var catalog: OfflineCatalog?
    private var embedder: OfflineEmbedder?
    private var knn: OfflineKNN?
    private var identifier: OfflineIdentifier?

    /// In-flight setup task. Coalesces concurrent setup calls.
    private var setupTask: Task<Void, Error>?

    init(
        manager: OfflineCatalogManager = .shared,
        anchorStore: OfflineCatalogAnchorStore = OfflineCatalogAnchorStore(),
    ) {
        self.manager = manager
        self.anchorStore = anchorStore
    }

    // MARK: - Setup

    /// Idempotent: returns immediately if already ready, awaits the
    /// in-flight setup if one's running, otherwise starts a new one.
    func ensureReady() async throws {
        if case .ready = setupState { return }
        if let task = setupTask {
            try await task.value
            return
        }
        let task = Task<Void, Error> { [weak self] in
            try await self?.runSetup()
        }
        setupTask = task
        defer { setupTask = nil }
        try await task.value
    }

    private func runSetup() async throws {
        setupState = .preparing(message: "Downloading catalog…")
        let cat: OfflineCatalog
        do {
            cat = try await manager.ensureReady()
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            setupState = .failed(message: msg)
            throw OfflineScanOrchestratorError.setupFailed(msg)
        }

        setupState = .preparing(message: "Loading model…")
        let emb: OfflineEmbedder
        do {
            emb = try OfflineEmbedder()
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            setupState = .failed(message: msg)
            throw OfflineScanOrchestratorError.setupFailed(msg)
        }

        // Hydrate anchor cache from disk synchronously (fast — small
        // file, microseconds) so the very first scan after a cold
        // launch already has any previously-synced anchors. Network
        // sync runs in parallel with the first scan via the
        // syncAnchorsInBackground call below.
        anchorStore.loadFromDiskIfPresent()
        let k = OfflineKNN(catalog: cat, anchorStore: anchorStore)
        let ident = OfflineIdentifier(catalog: cat, knn: k)

        self.catalog = cat
        self.embedder = emb
        self.knn = k
        self.identifier = ident
        setupState = .ready

        // Kick off a background anchor sync. Non-blocking; if network
        // is down we fall back to whatever loadFromDiskIfPresent
        // hydrated. New anchors are visible to subsequent scans.
        syncAnchorsInBackground()
    }

    /// Pull the anchor delta in the background. Coalesces against
    /// in-flight syncs. Errors are logged + swallowed — sync failures
    /// shouldn't block scanning.
    func syncAnchorsInBackground() {
        Task.detached { [weak self] in
            guard let self else { return }
            do {
                let added = try await self.anchorStore.sync()
                if added > 0 {
                    print("[orch] anchor sync added \(added) new anchor(s)")
                }
            } catch {
                print("[orch] anchor sync failed (non-fatal): \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Identify

    /// On-device identify (single-candidate convenience). Conforms to
    /// the same `ScanIdentifyResponse` shape the server returns so
    /// callers can swap implementations without changing downstream
    /// code. For multi-candidate OCR (the case where Vision's top-1
    /// digit reading might be wrong), use `identifyMulti` so the
    /// identifier can try alternate card_number candidates.
    func identify(
        image: UIImage,
        cardNumber: String?,
        setHint: String?,
        language: ScanLanguage,
        limit: Int = 5,
    ) async throws -> ScanIdentifyResponse {
        let candidates: [String] = cardNumber.map { [$0] } ?? []
        return try await identifyMulti(
            image: image,
            cardNumberCandidates: candidates,
            setHint: setHint,
            language: language,
            limit: limit,
        )
    }

    /// On-device identify with multi-candidate OCR. Tries each
    /// candidate against Path A/B; returns the first one that fires
    /// a narrow match, or falls back to Path C with the top
    /// candidate. See `OfflineIdentifier.identifyWithCandidates` for
    /// the routing detail.
    func identifyMulti(
        image: UIImage,
        cardNumberCandidates: [String],
        setHint: String?,
        language: ScanLanguage,
        limit: Int = 5,
    ) async throws -> ScanIdentifyResponse {
        try await ensureReady()
        guard let embedder = self.embedder, let identifier = self.identifier,
              let catalog = self.catalog else {
            throw OfflineScanOrchestratorError.notReady
        }

        // 1. Embed off the main actor.
        let queryEmbedding: [Float]
        do {
            queryEmbedding = try await Task.detached(priority: .userInitiated) {
                try embedder.embed(image: image)
            }.value
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            throw OfflineScanOrchestratorError.embedderFailed(msg)
        }

        // 2. Multi-candidate Path A/B/C routing.
        let result = identifier.identifyWithCandidates(
            queryEmbedding: queryEmbedding,
            language: language.rawValue,
            cardNumberCandidates: cardNumberCandidates,
            ocrSetHint: setHint,
            limit: limit,
        )

        // 3. Adapt to the network-shaped response.
        let imageHash = Self.computeImageHash(image: image)
        let matches: [ScanMatch] = result.matches.map { Self.adaptMatch($0) }
        return ScanIdentifyResponse(
            ok: true,
            confidence: result.confidence.rawValue,
            matches: matches,
            languageFilter: language.rawValue,
            modelVersion: catalog.modelVersion,
            imageHash: imageHash,
            winningPath: result.winningPath.rawValue,
        )
    }

    // MARK: - Adapter helpers

    private static func adaptMatch(_ match: OfflineIdentifyMatch) -> ScanMatch {
        let row = match.row
        return ScanMatch(
            slug: row.canonicalSlug,
            canonicalName: deriveCanonicalName(
                slug: row.canonicalSlug,
                setName: row.setName,
                cardNumber: row.cardNumber,
            ),
            language: row.language,
            setName: row.setName,
            cardNumber: prettyCardNumber(row.cardNumber),
            variant: nil,
            mirroredPrimaryImageUrl: imageUrl(forSlug: row.canonicalSlug),
            similarity: Double(match.similarity),
        )
    }

    /// Generates a pleasant canonical-name fallback by stripping the
    /// known `setSlug-cardNumber-` prefix from the slug and
    /// title-casing the remainder. v3 .papb format will eliminate
    /// this heuristic by carrying canonical_name explicitly.
    private static func deriveCanonicalName(
        slug: String,
        setName: String?,
        cardNumber: String?,
    ) -> String {
        // Best-effort: split on "-", drop tokens that look like the
        // set + card-number prefix, title-case the rest.
        var tokens = slug.split(separator: "-").map(String.init)
        // Slug pattern: <set-slug-tokens>-<cardnumber>-<name-tokens>
        // The card-number is the FIRST numeric-or-alphanumeric token
        // following at least one set-slug token. We approximate by
        // dropping tokens that match the set name's slug prefix +
        // the card number itself.
        if let setName, !setName.isEmpty {
            let setTokens = setName
                .lowercased()
                .replacingOccurrences(of: "&", with: "")
                .split { !$0.isLetter && !$0.isNumber }
                .map(String.init)
            // Drop any leading tokens that match setTokens.
            var i = 0
            while i < tokens.count, i < setTokens.count, tokens[i] == setTokens[i] {
                i += 1
            }
            tokens = Array(tokens.dropFirst(i))
        }
        // Drop leading card_number-like token (may have leading 0s,
        // alphanumerics like "tg04", or "rc23a").
        if let first = tokens.first {
            let numeric = first.allSatisfy { $0.isNumber }
            // alphanumeric promo-style codes like "tg04" or "swsh062"
            let alphaNumericPromo = first.contains { $0.isNumber } && first.allSatisfy { $0.isLetter || $0.isNumber }
            // Match against the actual card number too.
            let matchesActual = cardNumber.map { $0.lowercased().contains(first) } ?? false
            if numeric || alphaNumericPromo || matchesActual {
                tokens = Array(tokens.dropFirst())
            }
        }
        if tokens.isEmpty {
            return slug
                .split(separator: "-").map(String.init).map { $0.capitalized }
                .joined(separator: " ")
        }
        return tokens.map { $0.capitalized }.joined(separator: " ")
    }

    /// Strip the `/total` printed suffix for display (server
    /// canonical_cards stores the slash-free form anyway).
    private static func prettyCardNumber(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return raw }
        if let slash = raw.firstIndex(of: "/") {
            let head = raw[..<slash]
            let cleaned = head.trimmingCharacters(in: .whitespaces)
            // Drop leading zeros only when the head is pure digits.
            if cleaned.allSatisfy({ $0.isNumber }) {
                return cleaned.replacingOccurrences(
                    of: "^0+(?=\\d)",
                    with: "",
                    options: .regularExpression,
                )
            }
            return cleaned.isEmpty ? raw : cleaned
        }
        return raw
    }

    /// Canonical mirrored image URL (matches what the server's
    /// /api/scan/identify returns in `mirrored_primary_image_url`).
    private static func imageUrl(forSlug slug: String) -> String? {
        // Public Supabase Storage URL pattern. Same string format the
        // server emits for matched slugs, so the existing image cache
        // hits transparently.
        return "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/\(slug)/full.png"
    }

    private static func computeImageHash(image: UIImage) -> String? {
        // Mirror the server's hash format: sha256 of the JPEG bytes
        // it would have uploaded. For offline we don't actually
        // upload, but generating the hash means a future
        // promote-correction flow could match if the image is later
        // synced to scan-uploads.
        guard let jpeg = image.jpegData(compressionQuality: 0.8) else { return nil }
        let digest = SHA256.hash(data: jpeg)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
