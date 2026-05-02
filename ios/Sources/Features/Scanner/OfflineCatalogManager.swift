// OfflineCatalogManager.swift
//
// Owns the lifecycle of the on-device catalog bundle (.papb): finding
// it (local cache → bundled fallback), keeping it fresh against the
// remote copy in Supabase Storage, and exposing a single
// `ensureReady()` async API for callers that just want a working
// `OfflineCatalog` without caring how it got there.
//
// REMOTE LAYOUT (Supabase Storage, public bucket):
//
//   card-images/catalog-bundles/v1/siglip2_catalog_v1.papb
//
//   Public URL is hard-coded (`Self.remoteURL`). Anonymous GET — the
//   premium gate is enforced at the iOS layer (we only call into
//   ensureReady() for premium users), not at the storage layer. If a
//   non-premium user discovered the URL they could grab the file, but
//   it's not actionable without the matching CoreML model + Swift
//   pipeline. Future-proofing: switch to a signed URL endpoint when
//   we want hard storage-side gating.
//
// CHANGE DETECTION:
//
//   We use the HTTP ETag returned by Supabase Storage's CDN as the
//   single source of truth for "is the local file current?". On every
//   ensureReady():
//
//     1. HEAD the remote URL (cheap — no body transfer).
//     2. If local file exists AND content-length matches AND the
//        cached ETag (UserDefaults) matches the response → use local.
//     3. Otherwise → download fresh, validate size, atomically rename
//        into the cache path, persist the new ETag.
//
//   ETag is opaque — we don't try to parse it. Server flips it
//   whenever the .papb is reuploaded. Skipping a manifest layer
//   keeps the deployment story simple: rebuild the .papb, drag-drop
//   into Supabase, done.
//
// CONCURRENCY:
//
//   ensureReady() is async-safe under concurrent callers. The first
//   caller starts a download Task; subsequent callers `await` the
//   same task instead of racing. Internal state is guarded by an
//   actor (CatalogStateActor) so Swift Concurrency handles the
//   serialization for us — no NSLock plumbing.
//
// FALLBACK ORDER:
//
//   1. Application Support cache (downloaded copy)
//   2. Bundle.module resource (DEV builds with .papb checked in
//      under Resources/Catalog/ — gitignored, so prod IPAs never
//      have it).
//   3. Remote download.
//
//   Production flow on premium activation: cache miss → bundle miss
//   → download. Subsequent launches: cache hit → instant. Manager
//   still HEADs the remote on launch to detect upstream updates.

import Foundation

// MARK: - Public API

/// Observable lifecycle state for the catalog. UI surfaces (premium
/// activation flow, debug menus) bind to this to render progress
/// without leaking download mechanics.
public enum OfflineCatalogState: Equatable, Sendable {
    case idle
    case checking
    case downloading(progress: Double)  // 0.0...1.0; 0 if length unknown
    case ready
    case failed(message: String)

    public static func == (lhs: OfflineCatalogState, rhs: OfflineCatalogState) -> Bool {
        switch (lhs, rhs) {
        case (.idle, .idle): return true
        case (.checking, .checking): return true
        case (.downloading(let l), .downloading(let r)): return l == r
        case (.ready, .ready): return true
        case (.failed(let l), .failed(let r)): return l == r
        default: return false
        }
    }
}

public enum OfflineCatalogManagerError: Error, LocalizedError {
    case noBundledFallback
    case httpStatus(Int, url: URL)
    case sizeMismatch(expected: Int64, got: Int64)
    case writeFailed(underlying: Error)
    case loadAfterDownloadFailed(underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .noBundledFallback:
            return "No bundled .papb fallback and remote download failed."
        case .httpStatus(let code, let url):
            return "Catalog HTTP \(code) for \(url.lastPathComponent)"
        case .sizeMismatch(let exp, let got):
            return "Catalog size mismatch: expected \(exp) bytes, got \(got)"
        case .writeFailed(let err):
            return "Catalog write failed: \(err.localizedDescription)"
        case .loadAfterDownloadFailed(let err):
            return "Catalog re-load after download failed: \(err.localizedDescription)"
        }
    }
}

// MARK: - State actor (concurrency-safe inflight tracking)

private actor CatalogStateActor {
    var inflightTask: Task<OfflineCatalog, Error>?

    func setInflight(_ task: Task<OfflineCatalog, Error>) { inflightTask = task }
    func clearInflight() { inflightTask = nil }
    func currentInflight() -> Task<OfflineCatalog, Error>? { inflightTask }
}

// MARK: - Manager

public final class OfflineCatalogManager: @unchecked Sendable {
    public static let shared = OfflineCatalogManager()

    // Hard-coded remote URL. Bumping the catalog version means
    // changing this constant + uploading the new .papb to a new
    // path; the manager will detect the ETag delta and re-download.
    public static let remoteURL = URL(
        string: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/catalog-bundles/v1/siglip2_catalog_v1.papb",
    )!

    /// UserDefaults key for the cached ETag. Pairs with the file at
    /// `cacheFileURL` — clearing the file without clearing this is
    /// fine (we'll just re-download), clearing this without removing
    /// the file means we'll re-download even if the file is current.
    /// Acceptable on either side.
    public static let etagDefaultsKey = "ai.popalpha.scanner.offlineCatalog.etag"

    /// Resource name for the bundled fallback (DEV builds).
    private static let bundledResourceName = "siglip2_catalog_v1"
    private static let bundledResourceExt = "papb"

    /// Subscribe via KVO / Combine for UI binding. Updates always
    /// happen on the main queue.
    public private(set) var state: OfflineCatalogState = .idle {
        didSet {
            DispatchQueue.main.async { [weak self] in
                self?.stateDidChange?(self?.state ?? .idle)
            }
        }
    }

    /// Optional callback for SwiftUI bridges — easier than rolling
    /// our own ObservableObject when this lives in a non-UI module.
    public var stateDidChange: ((OfflineCatalogState) -> Void)?

    private let stateActor = CatalogStateActor()
    private let session: URLSession
    private let defaults: UserDefaults

    public init(
        session: URLSession = .shared,
        defaults: UserDefaults = .standard,
    ) {
        self.session = session
        self.defaults = defaults
    }

    // MARK: - Paths

    /// Where the cached .papb lives on-device. Application Support is
    /// the right Apple-guidance bucket for "data the app downloads
    /// and depends on but isn't user-generated"; it survives
    /// app-data-wipe in Settings only via explicit user action.
    public func cacheFileURL() throws -> URL {
        let fm = FileManager.default
        let supportDir = try fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true,
        )
        let dir = supportDir.appendingPathComponent("PopAlpha", isDirectory: true)
            .appendingPathComponent("catalog", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("siglip2_catalog_v1.papb", isDirectory: false)
    }

    public func bundledFileURL() -> URL? {
        return Bundle.module.url(
            forResource: Self.bundledResourceName,
            withExtension: Self.bundledResourceExt,
        )
    }

    public func cachedETag() -> String? {
        return defaults.string(forKey: Self.etagDefaultsKey)
    }

    public func cachedFileExists() -> Bool {
        guard let url = try? cacheFileURL() else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    public func cachedFileSize() -> Int64? {
        guard let url = try? cacheFileURL(),
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else {
            return nil
        }
        return size.int64Value
    }

    // MARK: - Public entry point

    /// Returns a ready-to-query `OfflineCatalog`. Cheap if the cache
    /// is current (one HEAD request); otherwise downloads + writes
    /// before returning.
    ///
    /// `forceRefresh: true` skips the cache freshness check and
    /// re-downloads unconditionally — primarily for QA / debug
    /// menus.
    public func ensureReady(
        forceRefresh: Bool = false,
        allowBundledFallback: Bool = true,
    ) async throws -> OfflineCatalog {
        // Coalesce concurrent callers onto a single inflight Task —
        // if a download is already in flight, just await it.
        if let inflight = await stateActor.currentInflight() {
            return try await inflight.value
        }

        let task = Task<OfflineCatalog, Error> {
            do {
                let cat = try await self.runEnsureReady(
                    forceRefresh: forceRefresh,
                    allowBundledFallback: allowBundledFallback,
                )
                self.state = .ready
                return cat
            } catch {
                self.state = .failed(message: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                throw error
            }
        }
        await stateActor.setInflight(task)
        defer { Task { await stateActor.clearInflight() } }
        return try await task.value
    }

    /// Drops the local cache + ETag. Next `ensureReady` will redownload.
    /// Useful for QA and for handling "user hit reset on premium settings".
    public func clearCache() throws {
        let fm = FileManager.default
        if let url = try? cacheFileURL(), fm.fileExists(atPath: url.path) {
            try fm.removeItem(at: url)
        }
        defaults.removeObject(forKey: Self.etagDefaultsKey)
    }

    // MARK: - Implementation

    private func runEnsureReady(
        forceRefresh: Bool,
        allowBundledFallback: Bool,
    ) async throws -> OfflineCatalog {
        self.state = .checking

        // 1. HEAD remote to discover ETag + size.
        let head: HeadInfo
        do {
            head = try await fetchRemoteHead()
        } catch {
            // No network — fall back to whatever local copy we have.
            if let local = try? loadFromLocalIfPresent(allowBundledFallback: allowBundledFallback) {
                return local
            }
            throw error
        }

        // 2. Determine if local cache is current.
        let cacheURL = try cacheFileURL()
        let fm = FileManager.default
        if !forceRefresh, fm.fileExists(atPath: cacheURL.path) {
            let cachedSize = (try? fm.attributesOfItem(atPath: cacheURL.path)[.size] as? NSNumber)?.int64Value ?? -1
            let cachedETag = cachedETag()
            if cachedSize == head.contentLength
                && cachedETag != nil
                && head.etag != nil
                && cachedETag == head.etag
            {
                // Cache hit — no download needed.
                return try OfflineCatalog.load(from: cacheURL)
            }
        }

        // 3. Download. Stream to a tmp file with progress so we don't
        //    hold the whole 35MB body in RAM, then atomic-rename.
        let tmpURL = cacheURL.appendingPathExtension("tmp")
        try? fm.removeItem(at: tmpURL)

        var downloadedBytes: Int64 = 0
        let expectedTotal = head.contentLength

        let (asyncBytes, response) = try await session.bytes(from: Self.remoteURL)
        if let httpResp = response as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw OfflineCatalogManagerError.httpStatus(httpResp.statusCode, url: Self.remoteURL)
        }
        let writeHandle: FileHandle
        fm.createFile(atPath: tmpURL.path, contents: nil)
        do {
            writeHandle = try FileHandle(forWritingTo: tmpURL)
        } catch {
            throw OfflineCatalogManagerError.writeFailed(underlying: error)
        }

        // Buffer a few KB at a time before flushing to FileHandle.
        // Bytes-at-a-time would issue one syscall per byte — disastrous
        // for 35MB.
        var buffer = Data()
        buffer.reserveCapacity(64 * 1024)
        let flushThreshold = 64 * 1024

        do {
            for try await byte in asyncBytes {
                buffer.append(byte)
                downloadedBytes += 1
                if buffer.count >= flushThreshold {
                    try writeHandle.write(contentsOf: buffer)
                    buffer.removeAll(keepingCapacity: true)
                    if expectedTotal > 0 {
                        let progress = Double(downloadedBytes) / Double(expectedTotal)
                        self.state = .downloading(progress: progress)
                    } else {
                        self.state = .downloading(progress: 0)
                    }
                }
            }
            if !buffer.isEmpty {
                try writeHandle.write(contentsOf: buffer)
            }
            try writeHandle.close()
        } catch {
            try? writeHandle.close()
            try? fm.removeItem(at: tmpURL)
            throw OfflineCatalogManagerError.writeFailed(underlying: error)
        }

        // 4. Validate size before swapping in.
        let writtenSize = (try? fm.attributesOfItem(atPath: tmpURL.path)[.size] as? NSNumber)?.int64Value ?? -1
        if expectedTotal > 0, writtenSize != expectedTotal {
            try? fm.removeItem(at: tmpURL)
            throw OfflineCatalogManagerError.sizeMismatch(expected: expectedTotal, got: writtenSize)
        }

        // 5. Atomic rename. If a previous file exists, replace it.
        do {
            if fm.fileExists(atPath: cacheURL.path) {
                _ = try fm.replaceItemAt(cacheURL, withItemAt: tmpURL)
            } else {
                try fm.moveItem(at: tmpURL, to: cacheURL)
            }
        } catch {
            try? fm.removeItem(at: tmpURL)
            throw OfflineCatalogManagerError.writeFailed(underlying: error)
        }

        // 6. Persist the new ETag for next-launch comparison.
        if let etag = head.etag {
            defaults.set(etag, forKey: Self.etagDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.etagDefaultsKey)
        }

        // 7. Load and return.
        do {
            return try OfflineCatalog.load(from: cacheURL)
        } catch {
            throw OfflineCatalogManagerError.loadAfterDownloadFailed(underlying: error)
        }
    }

    /// Try cache, then bundled fallback. Returns nil when neither
    /// has a usable file — caller is responsible for surfacing the
    /// download error in that case.
    private func loadFromLocalIfPresent(
        allowBundledFallback: Bool,
    ) throws -> OfflineCatalog? {
        let fm = FileManager.default
        if let cacheURL = try? cacheFileURL(), fm.fileExists(atPath: cacheURL.path) {
            return try? OfflineCatalog.load(from: cacheURL)
        }
        if allowBundledFallback, let bundledURL = bundledFileURL() {
            return try? OfflineCatalog.load(from: bundledURL)
        }
        return nil
    }

    // MARK: - HEAD request

    private struct HeadInfo {
        let etag: String?
        let contentLength: Int64
    }

    private func fetchRemoteHead() async throws -> HeadInfo {
        var req = URLRequest(url: Self.remoteURL)
        req.httpMethod = "HEAD"
        // 5s timeout — the catalog is on a CDN; if the HEAD takes
        // longer something's wrong, fall back to local.
        req.timeoutInterval = 5
        let (_, response) = try await session.data(for: req)
        guard let httpResp = response as? HTTPURLResponse else {
            throw OfflineCatalogManagerError.httpStatus(-1, url: Self.remoteURL)
        }
        if httpResp.statusCode != 200 {
            throw OfflineCatalogManagerError.httpStatus(httpResp.statusCode, url: Self.remoteURL)
        }
        let etag = httpResp.value(forHTTPHeaderField: "ETag")
        let lengthStr = httpResp.value(forHTTPHeaderField: "Content-Length") ?? ""
        let length = Int64(lengthStr) ?? -1
        return HeadInfo(etag: etag, contentLength: length)
    }
}
