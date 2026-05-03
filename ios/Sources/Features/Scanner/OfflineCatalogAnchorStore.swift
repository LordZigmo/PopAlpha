// OfflineCatalogAnchorStore.swift
//
// Pulls user_correction kNN anchors from /api/catalog/anchors-since
// and persists them to disk so the offline scanner can search over
// (base catalog + delta anchors) — meaning corrections users make
// via the picker actually reach the on-device scanner instead of
// silently disappearing into a static .papb.
//
// THE PROBLEM THIS SOLVES:
//
//   The base catalog (.papb) is a SNAPSHOT built from
//   card_image_embeddings at a specific point in time. User
//   corrections (created via /api/scan/correction) accumulate
//   server-side as new rows but never reach the iOS app's offline
//   catalog. Real-device 2026-05-02: the user corrected a Premium
//   Power Pro scan twice via the picker; on the third scan the
//   offline kNN had no awareness of the correction and returned
//   Pawniard at HIGH confidence, auto-navigating to a wrong card.
//
// MEMORY MODEL:
//
//   Anchors live in a heap-allocated `[Float]` (FP32, contiguous
//   row-major: row i embedding starts at index i*768). Distinct from
//   the .papb's mmap'd FP16 region — anchors stay editable and
//   appendable without remapping the file. Decoded JSON anchor list
//   is also cached as binary on disk so subsequent launches are
//   instant.
//
// CONCURRENCY:
//
//   `sync()` is async and idempotent under concurrent callers (a
//   second call while a first is in flight awaits the first instead
//   of double-fetching). Reads of `anchors` go through
//   `withAnchorsPointer` which acquires a `serialAccessQueue.sync`
//   barrier, ensuring we never read mid-write.
//
// CACHE FILE FORMAT (binary, on-disk):
//
//   Header (32 bytes, LE):
//     u32 magic = 0x50414153 ("PAAS" — PopAlpha Anchors Store)
//     u32 schema_version = 1
//     u32 anchor_count
//     u32 vector_dim = 768
//     u64 watermark_unix_ms      // last successful server_now timestamp
//     u64 reserved
//
//   Anchors (anchor_count × variable):
//     u32 slug_off       (offset into string blob)
//     u32 set_off
//     u32 num_off
//     u32 lang_off
//     u32 variant_index
//     u32 reserved
//     u8[8] reserved
//     [768 × float32]    // L2-normalized
//     = 32 + 3072 = 3104 bytes per anchor
//
//   String blob: appended after anchors, null-terminated UTF-8.
//
// Format mirrors the .papb's structure for consistency. We don't use
// the .papb itself for anchors because it's mmap'd read-only; this
// file is small, frequently-rewritten, and stays in heap memory.

import Foundation

public enum OfflineCatalogAnchorStoreError: Error, LocalizedError {
    case httpStatus(Int, url: URL)
    case decodeFailed(String)
    case writeFailed(underlying: Error)
    case readFailed(underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .httpStatus(let code, let url):
            return "Anchor sync HTTP \(code) for \(url.lastPathComponent)"
        case .decodeFailed(let detail):
            return "Anchor sync decode failed: \(detail)"
        case .writeFailed(let err):
            return "Anchor cache write failed: \(err.localizedDescription)"
        case .readFailed(let err):
            return "Anchor cache read failed: \(err.localizedDescription)"
        }
    }
}

/// Single anchor in memory. Mirrors `OfflineCatalogRow` + an embedding
/// blob, but kept as a separate type so changes to the .papb format
/// don't ripple here.
public struct OfflineCatalogAnchor: Sendable {
    public let canonicalSlug: String
    public let setName: String?
    public let cardNumber: String?
    public let language: String?
    public let variantIndex: UInt32
    public let updatedAtMs: Int64
    /// 768 floats, L2-normalized.
    public let embedding: [Float]
}

public final class OfflineCatalogAnchorStore: @unchecked Sendable {

    // MARK: - Public state

    /// Most recent set of anchors. Replaced atomically on a successful
    /// sync. Read via `withAnchorsPointer` from the kNN hot path —
    /// don't iterate this directly when search performance matters.
    public private(set) var anchors: [OfflineCatalogAnchor] = []

    /// Last successful server_now timestamp (ISO seconds × 1000).
    /// Used as the `since` parameter on the next sync so the server
    /// returns only delta rows.
    public private(set) var watermarkUnixMs: Int64 = 0

    public let modelVersion: String
    public let vectorDim: Int

    // MARK: - Internal

    private let serialAccessQueue = DispatchQueue(label: "ai.popalpha.scanner.anchors", qos: .userInitiated)
    private let session: URLSession
    private let baseURL: URL
    private var inflightSync: Task<Int, Error>?

    public static let defaultBaseURL = URL(string: "https://popalpha.ai")!

    // MARK: - Test seam

    /// Replaces the in-memory anchor list. Test-only — production
    /// callers should use `sync()`. Lets the smoke test inject a
    /// synthetic anchor and verify the kNN merge path without
    /// requiring the /api/catalog/anchors-since endpoint to be
    /// deployed.
    public func _seedAnchorsForTesting(_ anchors: [OfflineCatalogAnchor]) {
        serialAccessQueue.sync {
            self.anchors = anchors
        }
    }

    public init(
        modelVersion: String = "siglip2-base-patch16-384-v1",
        vectorDim: Int = 768,
        baseURL: URL = OfflineCatalogAnchorStore.defaultBaseURL,
        session: URLSession = .shared,
    ) {
        self.modelVersion = modelVersion
        self.vectorDim = vectorDim
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Disk paths

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
        return dir.appendingPathComponent("anchors.bin", isDirectory: false)
    }

    // MARK: - Public API

    /// Hydrate from disk if the cache exists. Cheap (microseconds for
    /// a few KB of anchors). Call once on app launch before sync().
    public func loadFromDiskIfPresent() {
        guard let url = try? cacheFileURL() else { return }
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let data = try Data(contentsOf: url)
            let parsed = try Self.deserialize(data: data, expectedVectorDim: vectorDim)
            serialAccessQueue.sync {
                self.anchors = parsed.anchors
                self.watermarkUnixMs = parsed.watermarkUnixMs
            }
        } catch {
            // Corrupt cache → log + ignore. Next sync rebuilds from
            // scratch (since=0).
            print("[anchorStore] cache load failed; will rebuild via sync: \(error.localizedDescription)")
        }
    }

    /// Fetches anchors-since the current watermark, merges into memory,
    /// and persists. Returns the number of NEW anchors pulled (0 if
    /// already up-to-date). Concurrent callers coalesce onto a single
    /// inflight task — fire as often as you like.
    @discardableResult
    public func sync() async throws -> Int {
        if let task = inflightSync {
            return try await task.value
        }
        let task = Task<Int, Error> { [weak self] in
            guard let self else { return 0 }
            return try await self.runSync()
        }
        inflightSync = task
        defer { inflightSync = nil }
        return try await task.value
    }

    /// Calls `body` with a pointer into a row-major Float array of
    /// size `numAnchors × vectorDim`. Pointer is valid only inside
    /// `body`. For use by `OfflineKNN` to run vDSP_mmul over the
    /// delta region in addition to the base .papb region.
    ///
    /// Uses `serialAccessQueue.sync` so the array isn't replaced
    /// mid-iteration by a concurrent sync.
    public func withAnchorsPointer<R>(
        _ body: (UnsafePointer<Float>?, _ numAnchors: Int) throws -> R
    ) rethrows -> R {
        return try serialAccessQueue.sync {
            if anchors.isEmpty {
                return try body(nil, 0)
            }
            // Build a contiguous fp32 buffer from the [Anchor] array.
            // Cached lazily? For now, materialize on every call —
            // anchor count is small (tens, maybe hundreds) so the
            // O(n × dim) copy is cheap. If it becomes hot we'll cache
            // a flat buffer alongside the [Anchor] array.
            let n = anchors.count
            var flat = [Float](repeating: 0, count: n * vectorDim)
            flat.withUnsafeMutableBufferPointer { buf in
                guard let base = buf.baseAddress else { return }
                for (i, anchor) in anchors.enumerated() {
                    let offset = i * vectorDim
                    for j in 0..<vectorDim {
                        base[offset + j] = anchor.embedding[j]
                    }
                }
            }
            return try flat.withUnsafeBufferPointer { buf in
                try body(buf.baseAddress, n)
            }
        }
    }

    // MARK: - Internals

    private struct AnchorJSON: Decodable {
        let canonical_slug: String
        let set_name: String?
        let card_number: String?
        let language: String?
        let variant_index: Int
        let updated_at: String
        let embedding: [Float]
    }

    private struct AnchorsResponse: Decodable {
        let ok: Bool
        let server_now: String
        let model_version: String
        let anchor_count: Int
        let anchors: [AnchorJSON]
    }

    private func runSync() async throws -> Int {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/catalog/anchors-since"
        var queryItems = [URLQueryItem(name: "model_version", value: modelVersion)]
        let watermark = serialAccessQueue.sync { self.watermarkUnixMs }
        if watermark > 0 {
            // Server expects ISO-8601; convert from ms.
            let date = Date(timeIntervalSince1970: TimeInterval(watermark) / 1000)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            queryItems.append(URLQueryItem(name: "since", value: formatter.string(from: date)))
        }
        components.queryItems = queryItems
        let url = components.url!

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)
        guard let httpResp = response as? HTTPURLResponse else {
            throw OfflineCatalogAnchorStoreError.httpStatus(-1, url: url)
        }
        if httpResp.statusCode != 200 {
            throw OfflineCatalogAnchorStoreError.httpStatus(httpResp.statusCode, url: url)
        }

        let parsed: AnchorsResponse
        do {
            parsed = try JSONDecoder().decode(AnchorsResponse.self, from: data)
        } catch {
            throw OfflineCatalogAnchorStoreError.decodeFailed(error.localizedDescription)
        }
        if !parsed.ok {
            throw OfflineCatalogAnchorStoreError.decodeFailed("server returned ok=false")
        }
        if parsed.model_version != modelVersion {
            throw OfflineCatalogAnchorStoreError.decodeFailed(
                "model_version mismatch: requested=\(modelVersion) got=\(parsed.model_version)",
            )
        }

        // Validate embeddings + parse server_now.
        var newAnchors: [OfflineCatalogAnchor] = []
        newAnchors.reserveCapacity(parsed.anchors.count)
        for raw in parsed.anchors {
            if raw.embedding.count != vectorDim {
                throw OfflineCatalogAnchorStoreError.decodeFailed(
                    "anchor embedding dim \(raw.embedding.count) != \(vectorDim) for \(raw.canonical_slug)",
                )
            }
            let updatedAtMs = Self.iso8601ToMs(raw.updated_at) ?? 0
            newAnchors.append(OfflineCatalogAnchor(
                canonicalSlug: raw.canonical_slug,
                setName: raw.set_name,
                cardNumber: raw.card_number,
                language: raw.language,
                variantIndex: UInt32(max(0, raw.variant_index)),
                updatedAtMs: updatedAtMs,
                embedding: raw.embedding,
            ))
        }

        let serverNowMs = Self.iso8601ToMs(parsed.server_now) ?? Int64(Date().timeIntervalSince1970 * 1000)

        // Merge with existing: union by (canonicalSlug, variantIndex).
        // Server returns updates — newer rows replace older ones.
        let addedCount = serialAccessQueue.sync { () -> Int in
            var byKey = [String: OfflineCatalogAnchor]()
            for a in self.anchors {
                byKey["\(a.canonicalSlug)|\(a.variantIndex)"] = a
            }
            var added = 0
            for a in newAnchors {
                let key = "\(a.canonicalSlug)|\(a.variantIndex)"
                if byKey[key] == nil { added += 1 }
                byKey[key] = a
            }
            self.anchors = byKey.values.sorted {
                ($0.canonicalSlug, $0.variantIndex) < ($1.canonicalSlug, $1.variantIndex)
            }
            self.watermarkUnixMs = max(self.watermarkUnixMs, serverNowMs)
            return added
        }

        // Persist to disk. Best-effort; logging the failure but not
        // throwing since the in-memory state is good.
        do {
            try persist()
        } catch {
            print("[anchorStore] persist failed: \(error.localizedDescription)")
        }
        return addedCount
    }

    private func persist() throws {
        let url = try cacheFileURL()
        let data = serialAccessQueue.sync { Self.serialize(anchors: self.anchors, watermarkUnixMs: self.watermarkUnixMs, vectorDim: self.vectorDim) }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw OfflineCatalogAnchorStoreError.writeFailed(underlying: error)
        }
    }

    // MARK: - Serialization

    private static let magic: UInt32 = 0x50414153  // "PAAS"
    private static let schemaVersion: UInt32 = 1
    private static let anchorRecordSize: Int = 32  // header bytes per anchor (before embedding)

    private static func serialize(anchors: [OfflineCatalogAnchor], watermarkUnixMs: Int64, vectorDim: Int) -> Data {
        var blob = Data()
        var stringOffsets = [String: UInt32]()
        // Reserve offset 0 for empty/null strings.
        blob.append(0)
        stringOffsets[""] = 0
        func internString(_ s: String?) -> UInt32 {
            let value = s ?? ""
            if let off = stringOffsets[value] { return off }
            let off = UInt32(blob.count)
            blob.append(value.data(using: .utf8) ?? Data())
            blob.append(0)
            stringOffsets[value] = off
            return off
        }

        // Build per-anchor records (header + embedding).
        let recordSize = anchorRecordSize + vectorDim * 4
        var anchorRegion = Data(count: anchors.count * recordSize)
        anchorRegion.withUnsafeMutableBytes { rawPtr in
            guard let base = rawPtr.baseAddress else { return }
            for (i, anchor) in anchors.enumerated() {
                let recordStart = base.advanced(by: i * recordSize)
                let slugOff = internString(anchor.canonicalSlug)
                let setOff = internString(anchor.setName)
                let numOff = internString(anchor.cardNumber)
                let langOff = internString(anchor.language)
                writeU32LE(into: recordStart.advanced(by: 0), slugOff)
                writeU32LE(into: recordStart.advanced(by: 4), setOff)
                writeU32LE(into: recordStart.advanced(by: 8), numOff)
                writeU32LE(into: recordStart.advanced(by: 12), langOff)
                writeU32LE(into: recordStart.advanced(by: 16), anchor.variantIndex)
                // bytes 20-31 reserved
                let embedStart = recordStart.advanced(by: anchorRecordSize)
                anchor.embedding.withUnsafeBufferPointer { src in
                    if let srcBase = src.baseAddress {
                        memcpy(embedStart, srcBase, vectorDim * 4)
                    }
                }
            }
        }

        // Header: 32 bytes
        var header = Data(count: 32)
        header.withUnsafeMutableBytes { rawPtr in
            guard let base = rawPtr.baseAddress else { return }
            writeU32LE(into: base.advanced(by: 0), magic)
            writeU32LE(into: base.advanced(by: 4), schemaVersion)
            writeU32LE(into: base.advanced(by: 8), UInt32(anchors.count))
            writeU32LE(into: base.advanced(by: 12), UInt32(vectorDim))
            writeU64LE(into: base.advanced(by: 16), UInt64(max(watermarkUnixMs, 0)))
            // bytes 24-31 reserved
        }

        var out = Data()
        out.append(header)
        out.append(anchorRegion)
        out.append(blob)
        return out
    }

    private static func deserialize(data: Data, expectedVectorDim: Int) throws -> (anchors: [OfflineCatalogAnchor], watermarkUnixMs: Int64) {
        guard data.count >= 32 else {
            throw OfflineCatalogAnchorStoreError.decodeFailed("file too small for header")
        }
        let magic = readU32LE(data: data, offset: 0)
        guard magic == Self.magic else {
            throw OfflineCatalogAnchorStoreError.decodeFailed("bad magic 0x\(String(magic, radix: 16))")
        }
        let schema = readU32LE(data: data, offset: 4)
        guard schema == Self.schemaVersion else {
            throw OfflineCatalogAnchorStoreError.decodeFailed("unsupported schema version \(schema)")
        }
        let count = Int(readU32LE(data: data, offset: 8))
        let dim = Int(readU32LE(data: data, offset: 12))
        guard dim == expectedVectorDim else {
            throw OfflineCatalogAnchorStoreError.decodeFailed("vector_dim \(dim) != expected \(expectedVectorDim)")
        }
        let watermark = Int64(bitPattern: readU64LE(data: data, offset: 16))

        let recordSize = anchorRecordSize + dim * 4
        let anchorRegionStart = 32
        let anchorRegionEnd = anchorRegionStart + count * recordSize
        guard data.count >= anchorRegionEnd else {
            throw OfflineCatalogAnchorStoreError.decodeFailed("truncated: needed \(anchorRegionEnd) bytes, got \(data.count)")
        }
        let blobStart = anchorRegionEnd

        func readString(at offset: Int) -> String {
            let absolute = blobStart + offset
            guard absolute < data.count else { return "" }
            var end = absolute
            while end < data.count && data[end] != 0 { end += 1 }
            if end <= absolute { return "" }
            return String(data: data.subdata(in: absolute..<end), encoding: .utf8) ?? ""
        }

        var out: [OfflineCatalogAnchor] = []
        out.reserveCapacity(count)
        for i in 0..<count {
            let recordStart = anchorRegionStart + i * recordSize
            let slugOff = Int(readU32LE(data: data, offset: recordStart))
            let setOff = Int(readU32LE(data: data, offset: recordStart + 4))
            let numOff = Int(readU32LE(data: data, offset: recordStart + 8))
            let langOff = Int(readU32LE(data: data, offset: recordStart + 12))
            let variantIndex = readU32LE(data: data, offset: recordStart + 16)

            let embedStart = recordStart + anchorRecordSize
            var embedding = [Float](repeating: 0, count: dim)
            embedding.withUnsafeMutableBufferPointer { dst in
                if let dstBase = dst.baseAddress {
                    data.withUnsafeBytes { src in
                        guard let srcBase = src.baseAddress else { return }
                        memcpy(dstBase, srcBase.advanced(by: embedStart), dim * 4)
                    }
                }
            }

            out.append(OfflineCatalogAnchor(
                canonicalSlug: readString(at: slugOff),
                setName: setOff == 0 ? nil : readString(at: setOff),
                cardNumber: numOff == 0 ? nil : readString(at: numOff),
                language: langOff == 0 ? nil : readString(at: langOff),
                variantIndex: variantIndex,
                updatedAtMs: 0,
                embedding: embedding,
            ))
        }
        return (out, watermark)
    }

    // MARK: - Endian helpers

    private static func writeU32LE(into ptr: UnsafeMutableRawPointer, _ value: UInt32) {
        var v = value.littleEndian
        memcpy(ptr, &v, 4)
    }

    private static func writeU64LE(into ptr: UnsafeMutableRawPointer, _ value: UInt64) {
        var v = value.littleEndian
        memcpy(ptr, &v, 8)
    }

    private static func readU32LE(data: Data, offset: Int) -> UInt32 {
        return data.subdata(in: offset..<(offset + 4)).withUnsafeBytes { rawBuf in
            rawBuf.load(as: UInt32.self).littleEndian
        }
    }

    private static func readU64LE(data: Data, offset: Int) -> UInt64 {
        return data.subdata(in: offset..<(offset + 8)).withUnsafeBytes { rawBuf in
            rawBuf.load(as: UInt64.self).littleEndian
        }
    }

    // MARK: - Time helpers

    private static func iso8601ToMs(_ value: String) -> Int64? {
        // Try with fractional seconds first, fall back to without.
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) {
            return Int64((date.timeIntervalSince1970 * 1000).rounded())
        }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        if let date = basic.date(from: value) {
            return Int64((date.timeIntervalSince1970 * 1000).rounded())
        }
        return nil
    }
}
