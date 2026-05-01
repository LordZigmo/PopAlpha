// OfflineKNN.swift
//
// On-device kNN over an OfflineCatalog. Uses Accelerate's vDSP for
// the dot-product hot path — cosine similarity reduces to dot
// product on L2-normalized vectors, and vDSP's matrix-vector kernels
// are well-tuned for Apple Silicon.
//
// Performance budget for the premium offline scanner:
//     - Catalog: 23,136 rows × 768 dim
//     - On M-series Neural Engine + Accelerate vDSP: target ≤50ms
//       per query. Brute-force dot product is fine at this scale —
//       no need for an HNSW or IVF index in the iOS bundle.
//
// Memory: queries + catalog read direct from the mmap'd bundle. The
// fp32 catalog query path materializes nothing extra. The fp16
// catalog path expands rows lazily via vDSP_vfromhalf into a small
// reusable scratch buffer (`fp16Scratch`) — keeps the hot path
// allocation-free.

import Accelerate
import Foundation

/// One result row of a kNN query, with similarity score + the
/// catalog metadata for the matched row.
public struct OfflineKNNHit: Sendable {
    public let row: OfflineCatalogRow
    public let similarity: Float  // dot product of L2-normalized vectors == cosine
}

public final class OfflineKNN {
    public let catalog: OfflineCatalog
    private let vectorDim: Int
    private let numRows: Int

    /// Scratch space for fp16→fp32 catalog conversion, reused across
    /// queries. Only allocated when the catalog dtype is fp16.
    private var fp16Scratch: [Float] = []
    private var fp16ScratchPopulated = false

    /// Reusable similarity-scores buffer, sized once. Avoids per-query
    /// `[Float]` allocation in the hot path.
    private var simBuffer: [Float]

    public init(catalog: OfflineCatalog) {
        self.catalog = catalog
        self.vectorDim = catalog.vectorDim
        self.numRows = catalog.numRows
        self.simBuffer = [Float](repeating: 0, count: catalog.numRows)
        if catalog.dtype == .float16 {
            self.fp16Scratch = [Float](repeating: 0, count: catalog.numRows * catalog.vectorDim)
        }
    }

    /// Runs kNN on the L2-normalized `query` vector. Returns the top
    /// `k` rows by cosine similarity, descending. The `query` must be
    /// `vectorDim` floats (768) and itself L2-normalized — caller's
    /// responsibility to normalize before invoking.
    ///
    /// Hot path:
    ///     1. (fp16 catalog only) Decode entire catalog to fp32 once
    ///        on first call; reuse the buffer thereafter.
    ///     2. Run vDSP matrix-vector multiply: `sims[i] = catalog[i] · query`.
    ///        With both sides L2-normalized, `sims[i]` is the cosine
    ///        similarity in `[-1, 1]`.
    ///     3. Top-k via partial sort (linear scan with a small heap).
    ///
    /// Note: we deliberately don't expose the raw similarity scores
    /// outside of `OfflineKNNHit` because callers should treat
    /// "tier" (high/medium/low confidence) as the user-facing signal,
    /// matched to the route's existing `classifyConfidence` thresholds.
    /// The `similarity` field is exposed for debugging + telemetry.
    public func topK(query: [Float], k: Int) -> [OfflineKNNHit] {
        precondition(
            query.count == vectorDim,
            "query has \(query.count) elements; expected \(vectorDim)",
        )
        precondition(k > 0, "k must be positive")

        let kCapped = min(k, numRows)

        // Decode the catalog once if fp16. A future optimization could
        // do this lazily per-row, but full upfront expand is simpler
        // and 35MB → 70MB scratch is fine for 23k rows on iPhone.
        if catalog.dtype == .float16 {
            ensureFp16Scratch()
        }

        // Compute sims[i] = dot(catalog[i], query) for all i.
        catalog.withEmbeddingsPointer { embeddingsPtr in
            switch catalog.dtype {
            case .float32:
                let catalogF32 = embeddingsPtr.bindMemory(
                    to: Float.self, capacity: numRows * vectorDim,
                )
                computeSims(catalogF32: catalogF32, query: query)
            case .float16:
                fp16Scratch.withUnsafeBufferPointer { scratchBuf in
                    computeSims(catalogF32: scratchBuf.baseAddress!, query: query)
                }
            }
        }

        // Top-k. For k=5 over 23k rows a linear scan beats a sort.
        return topKFromSims(k: kCapped)
    }

    /// Converts the catalog's fp16 region into the fp32 scratch buffer.
    /// Idempotent — populates once on first call, reused thereafter.
    /// One-time cost: ~30-50ms for 23k×768 elements via scalar
    /// `Float(Float16(bitPattern:))`. This runs on the first kNN
    /// query after catalog load, so the user sees ~50ms extra on
    /// scan #1 and the rest are clean.
    private func ensureFp16Scratch() {
        guard catalog.dtype == .float16, !fp16ScratchPopulated else { return }
        catalog.withEmbeddingsPointer { embeddingsPtr in
            let halfPtr = embeddingsPtr.bindMemory(
                to: UInt16.self,
                capacity: numRows * vectorDim,
            )
            fp16Scratch.withUnsafeMutableBufferPointer { scratchBuf in
                let n = numRows * vectorDim
                for i in 0..<n {
                    // Float16 (Swift built-in, iOS 14+) → Float bridge.
                    scratchBuf[i] = Float(Float16(bitPattern: halfPtr[i]))
                }
            }
        }
        fp16ScratchPopulated = true
    }

    /// Inner loop: sims[i] = dot(catalog[i], query) for i in 0..<numRows.
    /// Uses vDSP_mvmul which is optimized for matrix-vector products
    /// on Apple Silicon.
    private func computeSims(
        catalogF32: UnsafePointer<Float>,
        query: [Float],
    ) {
        query.withUnsafeBufferPointer { queryBuf in
            simBuffer.withUnsafeMutableBufferPointer { simBuf in
                vDSP_mmul(
                    catalogF32, 1,
                    queryBuf.baseAddress!, 1,
                    simBuf.baseAddress!, 1,
                    vDSP_Length(numRows),
                    vDSP_Length(1),
                    vDSP_Length(vectorDim),
                )
            }
        }
    }

    /// Returns the top-k rows by similarity. Uses a small heap-like
    /// linear scan since k is typically 1-5.
    private func topKFromSims(k: Int) -> [OfflineKNNHit] {
        // For tiny k, a simple O(n*k) scan beats a full sort.
        var topIdxs = [Int](); topIdxs.reserveCapacity(k)
        var topSims = [Float](); topSims.reserveCapacity(k)

        for i in 0..<numRows {
            let s = simBuffer[i]
            if topIdxs.count < k {
                topIdxs.append(i)
                topSims.append(s)
                // Tiny insertion sort to keep top descending
                var j = topIdxs.count - 1
                while j > 0 && topSims[j] > topSims[j - 1] {
                    topSims.swapAt(j, j - 1)
                    topIdxs.swapAt(j, j - 1)
                    j -= 1
                }
            } else if s > topSims[k - 1] {
                // Replace the worst-currently-in-top, then insertion-sort up
                topIdxs[k - 1] = i
                topSims[k - 1] = s
                var j = k - 1
                while j > 0 && topSims[j] > topSims[j - 1] {
                    topSims.swapAt(j, j - 1)
                    topIdxs.swapAt(j, j - 1)
                    j -= 1
                }
            }
        }

        return zip(topIdxs, topSims).map { idx, sim in
            OfflineKNNHit(row: catalog.rows[idx], similarity: sim)
        }
    }
}
