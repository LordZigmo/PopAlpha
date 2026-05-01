// OfflineCatalog.swift
//
// Loads the PopAlpha catalog bundle (.papb) for the on-device offline
// scanner (premium tier). The bundle is built by
// `cog/siglip-features/build_catalog_bundle.py` and downloaded from
// Supabase Storage on premium activation.
//
// Format reference: see the docstring at the top of
// build_catalog_bundle.py. Summary:
//
//   Header (64 bytes, little-endian):
//     u32 magic = 0x50415042 ("PAPB")
//     u32 format_version = 2
//     u32 num_rows
//     u32 vector_dim = 768
//     u8  dtype (0 = float32, 1 = float16)
//     u8[15] reserved
//     u64 model_version_offset
//     u64 metadata_offset
//     u64 string_blob_offset
//     u64 string_blob_size
//
//   Embeddings: num_rows × vector_dim × dtype bytes, L2-normalized.
//   Metadata:   24 bytes per row (offsets into string blob + variant + source).
//   String blob: null-terminated UTF-8 strings, offset 0 reserved for "".
//   Model version: trailing null-terminated UTF-8 string.
//
// Memory model: the embeddings region is mapped via Data(contentsOf:
// options: .alwaysMapped). Catalog metadata + strings are parsed
// eagerly into Swift values on load (sub-millisecond, sub-MB).
//
// This module is OFFLINE-ONLY. Network sync of new catalog rows is
// the catalog-sync layer's job (see CatalogSync.swift, post-launch).

import Foundation

public enum OfflineCatalogError: Error, LocalizedError {
    case fileNotFound(URL)
    case invalidMagic(UInt32)
    case unsupportedFormatVersion(UInt32)
    case unsupportedDimension(UInt32)
    case unknownDtype(UInt8)
    case truncatedBundle(expected: Int, got: Int)
    case malformedString(offset: Int)

    public var errorDescription: String? {
        switch self {
        case .fileNotFound(let url):
            return "Catalog bundle not found at \(url.path)."
        case .invalidMagic(let m):
            return "Bundle magic mismatch: 0x\(String(m, radix: 16)) — not a PAPB file."
        case .unsupportedFormatVersion(let v):
            return "Unsupported PAPB format_version \(v); this build only knows v2."
        case .unsupportedDimension(let d):
            return "Unsupported vector_dim \(d); expected 768."
        case .unknownDtype(let b):
            return "Unknown PAPB dtype byte \(b); expected 0 (fp32) or 1 (fp16)."
        case .truncatedBundle(let expected, let got):
            return "Catalog bundle truncated: needed \(expected) bytes, file has \(got)."
        case .malformedString(let offset):
            return "Malformed null-terminated string at blob offset \(offset)."
        }
    }
}

public enum OfflineCatalogDtype: UInt8 {
    case float32 = 0
    case float16 = 1
}

/// Per-row metadata held in RAM. The strings are pre-decoded so kNN
/// hot path doesn't pay UTF-8 cost.
public struct OfflineCatalogRow: Sendable {
    public let canonicalSlug: String
    public let setName: String?
    public let cardNumber: String?
    public let language: String?
    public let variantIndex: UInt32
    public let source: UInt8  // 0 = catalog, 1 = user_correction
}

/// In-memory representation of a `.papb` bundle. Embeddings stay
/// memory-mapped (no full read into RAM); metadata + strings are
/// parsed eagerly because they're small (~1MB total for 23k rows).
///
/// Thread-safety: read-only after `load()`. Concurrent kNN queries
/// against the same `OfflineCatalog` instance are safe; the kNN
/// module reads the embeddings region but never mutates it.
public final class OfflineCatalog {
    public let numRows: Int
    public let vectorDim: Int
    public let dtype: OfflineCatalogDtype
    public let modelVersion: String
    public let rows: [OfflineCatalogRow]

    /// Memory-mapped backing data. Hold a reference so the OS doesn't
    /// unmap while kNN is in flight.
    private let backing: Data
    /// Byte offset of the embeddings region within `backing`.
    public let embeddingsOffset: Int
    /// Number of bytes per element in the embeddings region.
    public var bytesPerElement: Int {
        switch dtype {
        case .float32: return 4
        case .float16: return 2
        }
    }
    /// Total bytes of the embeddings region.
    public var embeddingsByteCount: Int {
        return numRows * vectorDim * bytesPerElement
    }

    private init(
        numRows: Int,
        vectorDim: Int,
        dtype: OfflineCatalogDtype,
        modelVersion: String,
        rows: [OfflineCatalogRow],
        backing: Data,
        embeddingsOffset: Int
    ) {
        self.numRows = numRows
        self.vectorDim = vectorDim
        self.dtype = dtype
        self.modelVersion = modelVersion
        self.rows = rows
        self.backing = backing
        self.embeddingsOffset = embeddingsOffset
    }

    /// Loads a bundle from disk via mmap. The embeddings region stays
    /// page-fault-loaded; metadata + strings are parsed eagerly.
    public static func load(from url: URL) throws -> OfflineCatalog {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attrs?[.size] as? NSNumber)?.intValue ?? -1
        if fileSize < 0 {
            throw OfflineCatalogError.fileNotFound(url)
        }

        // Memory-map the entire file. For a 35MB FP16 bundle the OS
        // pages in lazily; iOS scanners that only touch the top-K
        // results never load every page.
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        if data.count < 64 {
            throw OfflineCatalogError.truncatedBundle(expected: 64, got: data.count)
        }

        // Parse header. Layout matches the Python writer.
        let magic = data.readU32LE(at: 0)
        if magic != 0x50415042 {  // "PAPB" little-endian
            throw OfflineCatalogError.invalidMagic(magic)
        }
        let formatVersion = data.readU32LE(at: 4)
        if formatVersion != 2 {
            throw OfflineCatalogError.unsupportedFormatVersion(formatVersion)
        }
        let numRows = Int(data.readU32LE(at: 8))
        let vectorDim = UInt32(data.readU32LE(at: 12))
        if vectorDim != 768 {
            throw OfflineCatalogError.unsupportedDimension(vectorDim)
        }
        let dtypeRaw = data[16]
        guard let dtype = OfflineCatalogDtype(rawValue: dtypeRaw) else {
            throw OfflineCatalogError.unknownDtype(dtypeRaw)
        }
        // bytes 17..32 reserved
        let modelVersionOffset = Int(data.readU64LE(at: 32))
        let metadataOffset = Int(data.readU64LE(at: 40))
        let stringBlobOffset = Int(data.readU64LE(at: 48))
        // stringBlobSize at 56 — we don't need it for parsing because
        // the model_version starts right after, but useful for asserts.
        let stringBlobSize = Int(data.readU64LE(at: 56))

        // Sanity: file is large enough for everything the header claims.
        let bytesPerElement = (dtype == .float32) ? 4 : 2
        let embeddingsRegionSize = numRows * Int(vectorDim) * bytesPerElement
        let metadataRegionSize = numRows * 24
        let needsAtLeast = 64 + embeddingsRegionSize + metadataRegionSize + stringBlobSize
        if data.count < needsAtLeast {
            throw OfflineCatalogError.truncatedBundle(expected: needsAtLeast, got: data.count)
        }

        // Parse the model_version string (null-terminated UTF-8).
        let modelVersion = try data.readCString(startingAt: modelVersionOffset)

        // Parse metadata + resolve strings eagerly.
        var rows = [OfflineCatalogRow]()
        rows.reserveCapacity(numRows)
        for i in 0..<numRows {
            let recordStart = metadataOffset + i * 24
            let slugOff = Int(data.readU32LE(at: recordStart))
            let setOff = Int(data.readU32LE(at: recordStart + 4))
            let numOff = Int(data.readU32LE(at: recordStart + 8))
            let langOff = Int(data.readU32LE(at: recordStart + 12))
            let variantIndex = data.readU32LE(at: recordStart + 16)
            let source = data[recordStart + 20]

            let slug = try data.readCString(startingAt: stringBlobOffset + slugOff)
            let setName = setOff == 0
                ? nil
                : try data.readCString(startingAt: stringBlobOffset + setOff)
            let cardNumber = numOff == 0
                ? nil
                : try data.readCString(startingAt: stringBlobOffset + numOff)
            let language = langOff == 0
                ? nil
                : try data.readCString(startingAt: stringBlobOffset + langOff)
            rows.append(OfflineCatalogRow(
                canonicalSlug: slug,
                setName: setName,
                cardNumber: cardNumber,
                language: language,
                variantIndex: variantIndex,
                source: source,
            ))
        }

        return OfflineCatalog(
            numRows: numRows,
            vectorDim: Int(vectorDim),
            dtype: dtype,
            modelVersion: modelVersion,
            rows: rows,
            backing: data,
            embeddingsOffset: 64,
        )
    }

    /// Calls `body` with a raw pointer to the embeddings region.
    /// The pointer is valid only for the duration of `body`. The
    /// region is `numRows * vectorDim * bytesPerElement` bytes.
    ///
    /// Use this from `OfflineKNN` to feed vDSP without copying.
    public func withEmbeddingsPointer<R>(
        _ body: (UnsafeRawPointer) throws -> R
    ) rethrows -> R {
        return try backing.withUnsafeBytes { rawBuf in
            let base = rawBuf.baseAddress!.advanced(by: embeddingsOffset)
            return try body(base)
        }
    }
}

// MARK: - Little-endian readers

private extension Data {
    func readU32LE(at offset: Int) -> UInt32 {
        return self.subdata(in: offset..<(offset + 4)).withUnsafeBytes { rawBuf in
            rawBuf.load(as: UInt32.self).littleEndian
        }
    }

    func readU64LE(at offset: Int) -> UInt64 {
        return self.subdata(in: offset..<(offset + 8)).withUnsafeBytes { rawBuf in
            rawBuf.load(as: UInt64.self).littleEndian
        }
    }

    /// Reads a null-terminated UTF-8 string. Throws if no NUL is
    /// found within the file (defensive — shouldn't happen if the
    /// Python writer is sane).
    func readCString(startingAt offset: Int) throws -> String {
        // Look for a NUL byte in [offset, count).
        var end = offset
        while end < self.count && self[end] != 0 {
            end += 1
        }
        if end >= self.count {
            throw OfflineCatalogError.malformedString(offset: offset)
        }
        return String(
            data: self.subdata(in: offset..<end),
            encoding: .utf8
        ) ?? ""
    }
}
