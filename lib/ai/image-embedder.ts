/**
 * Image embedder abstraction for the scanner pipeline.
 *
 * Phase 1 ships a Replicate-hosted OpenCLIP ViT-L/14 implementation
 * (andreasjansson/clip-features — 768 dims). A later phase can swap to
 * a fine-tuned model or a self-hosted instance by implementing the same
 * interface — ingestion + identify route both depend only on the shape.
 *
 * The `modelVersion` string is stored alongside every embedding and
 * feeds the source-hash so we re-embed exactly the rows whose model
 * identity changed when we upgrade.
 */

export type ImageEmbedResult =
  | { embedding: number[]; error: null }
  | { embedding: null; error: string };

export interface ImageEmbedder {
  readonly modelVersion: string;
  readonly dimensions: number;

  /**
   * Embed one or more publicly-fetchable image URLs.
   *
   * Resilience contract: a transient / per-URL failure (e.g. a single
   * image the backend couldn't fetch) returns `{ embedding: null,
   * error: "..." }` at that index, but does NOT throw — the other URLs
   * in the batch still complete. Only total failures (auth,
   * connectivity, malformed response) throw `ImageEmbedderRuntimeError`.
   *
   * The returned array is aligned 1:1 with the input array by index.
   */
  embedUrls(urls: string[]): Promise<ImageEmbedResult[]>;

  /**
   * Embed raw image bytes (e.g. a user-uploaded JPEG). Used by the
   * scanner identify path where the input is a just-captured frame
   * with no public URL. Throws `ImageEmbedderRuntimeError` on failure
   * — fail-fast is the right contract for interactive scans since the
   * caller has no partial-batch to salvage.
   */
  embedBytes(bytes: Buffer, mimeType: string): Promise<number[]>;
}

export class ImageEmbedderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEmbedderConfigError";
  }
}

export class ImageEmbedderRuntimeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ImageEmbedderRuntimeError";
  }
}

/**
 * Tags shipped into card_image_embeddings.model_version, one per
 * supported embedding model. The kNN_QUERY in /api/scan/identify
 * filters by this tag, which is how CLIP and SigLIP rows coexist in
 * the same table — only the rows matching the active embedder's
 * modelVersion participate in retrieval.
 *
 * IMAGE_EMBEDDER_MODEL_VERSION below resolves to whichever tag the
 * active variant uses, so callers that import the constant
 * automatically follow the cutover.
 */
export const IMAGE_EMBEDDER_MODEL_VERSION_CLIP = "replicate-clip-vit-l-14-v1";
export const IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP = "siglip2-base-patch16-384-v1";

/**
 * Active model_version tag — driven by the IMAGE_EMBEDDER_VARIANT env
 * var so the cutover and rollback are both env-only:
 *   IMAGE_EMBEDDER_VARIANT=modal-siglip → SigLIP active
 *   anything else (or unset)            → CLIP active (default)
 */
function resolveActiveModelVersion(): string {
  const variant = process.env.IMAGE_EMBEDDER_VARIANT?.trim();
  if (variant === "modal-siglip") return IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP;
  return IMAGE_EMBEDDER_MODEL_VERSION_CLIP;
}

export const IMAGE_EMBEDDER_MODEL_VERSION = resolveActiveModelVersion();

/** Output dimensionality. Both CLIP-L/14 and SigLIP-2-Base-384 land at
 * 768, so the pgvector column stays `vector(768)` across the cutover. */
export const IMAGE_EMBEDDER_DIMENSIONS = 768;

/**
 * Max URLs per Replicate prediction. andreasjansson/clip-features runs
 * on a T4 (~15 GiB VRAM) and OOMs when handed >~16 images at once. 8
 * leaves comfortable headroom; tunable via REPLICATE_CLIP_BATCH_SIZE.
 */
export const REPLICATE_CLIP_DEFAULT_BATCH_SIZE = 8;

function resolveReplicateBatchSize(): number {
  const raw = process.env.REPLICATE_CLIP_BATCH_SIZE?.trim();
  if (!raw) return REPLICATE_CLIP_DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return REPLICATE_CLIP_DEFAULT_BATCH_SIZE;
  return Math.min(parsed, 32);
}

export function hasReplicateConfig(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim() && process.env.REPLICATE_CLIP_MODEL_VERSION?.trim());
}

export function getReplicateClipEmbedder(): ReplicateClipEmbedder {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  const version = process.env.REPLICATE_CLIP_MODEL_VERSION?.trim();

  if (!token) {
    throw new ImageEmbedderConfigError("Missing REPLICATE_API_TOKEN.");
  }

  if (!version) {
    throw new ImageEmbedderConfigError(
      "Missing REPLICATE_CLIP_MODEL_VERSION. Pin to a specific andreasjansson/clip-features version hash.",
    );
  }

  return new ReplicateClipEmbedder({
    token,
    version,
    maxBatchSize: resolveReplicateBatchSize(),
  });
}

type ReplicatePredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

type ReplicatePrediction = {
  id: string;
  status: ReplicatePredictionStatus;
  output: Array<{ input: string; embedding: number[] }> | null;
  error: string | null;
};

/**
 * Replicate-hosted OpenCLIP ViT-L/14 via andreasjansson/clip-features.
 *
 * The model accepts a newline-separated list of URLs (or texts) and
 * returns `{ input, embedding }` pairs preserving order. We POST the
 * prediction with `Prefer: wait` so small batches complete in a single
 * HTTP round-trip; if the server still returns a non-terminal state we
 * fall back to a bounded poll on /v1/predictions/{id}.
 */
export class ReplicateClipEmbedder implements ImageEmbedder {
  public readonly modelVersion = IMAGE_EMBEDDER_MODEL_VERSION;
  public readonly dimensions = IMAGE_EMBEDDER_DIMENSIONS;

  private readonly token: string;
  private readonly version: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly maxBatchSize: number;

  constructor(opts: {
    token: string;
    version: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
    maxBatchSize?: number;
  }) {
    this.token = opts.token;
    this.version = opts.version;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
    this.maxBatchSize = opts.maxBatchSize ?? REPLICATE_CLIP_DEFAULT_BATCH_SIZE;
  }

  /**
   * Embeds an arbitrary-length list of URLs by chunking internally to
   * respect the backing model's GPU memory ceiling. When a chunk fails
   * (commonly: a single unreachable URL poisoning the whole batch), we
   * fall back to per-URL single-shot calls so the other URLs in the
   * chunk still succeed. Per-URL failures surface as `{ embedding:
   * null, error }` at the corresponding output index.
   */
  async embedUrls(urls: string[]): Promise<ImageEmbedResult[]> {
    if (urls.length === 0) return [];

    const out: ImageEmbedResult[] = urls.map(() => ({
      embedding: null,
      error: "unprocessed",
    }));

    for (let offset = 0; offset < urls.length; offset += this.maxBatchSize) {
      const chunk = urls.slice(offset, offset + this.maxBatchSize);

      try {
        const embeddings = await this.embedChunk(chunk);
        for (let i = 0; i < chunk.length; i += 1) {
          out[offset + i] = { embedding: embeddings[i]!, error: null };
        }
        continue;
      } catch (err) {
        if (!(err instanceof ImageEmbedderRuntimeError)) throw err;

        // Chunk failed — most likely one URL is unreachable. Retry each
        // URL alone so the broken ones are isolated and the healthy
        // ones still land. Singletons never OOM and can't poison each
        // other.
        for (let i = 0; i < chunk.length; i += 1) {
          try {
            const single = await this.embedChunk([chunk[i]!]);
            out[offset + i] = { embedding: single[0]!, error: null };
          } catch (singleErr) {
            if (!(singleErr instanceof ImageEmbedderRuntimeError)) throw singleErr;
            const message = singleErr.message.slice(0, 500);
            console.warn(
              `[image-embedder] skipping URL after per-chunk fallback failed: ${chunk[i]} — ${message}`,
            );
            out[offset + i] = { embedding: null, error: message };
          }
        }
      }
    }

    return out;
  }

  /**
   * Embed a single image from raw bytes. Wraps the bytes as a data URL
   * so we can reuse the same Replicate input path — the model accepts
   * both http(s) and data-URL inputs interchangeably.
   */
  async embedBytes(bytes: Buffer, mimeType: string): Promise<number[]> {
    const base64 = bytes.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const embeddings = await this.embedChunk([dataUrl]);
    const first = embeddings[0];
    if (!first) {
      throw new ImageEmbedderRuntimeError("embedBytes received empty embedding output");
    }
    return first;
  }

  private async embedChunk(urls: string[]): Promise<number[][]> {
    const inputsText = urls.join("\n");
    const prediction = await this.createPrediction(inputsText);
    const completed = await this.awaitCompletion(prediction);

    if (completed.status !== "succeeded" || !completed.output) {
      throw new ImageEmbedderRuntimeError(
        `Replicate prediction ${completed.id} ended in status=${completed.status}: ${completed.error ?? "unknown error"}`,
      );
    }

    if (completed.output.length !== urls.length) {
      throw new ImageEmbedderRuntimeError(
        `Replicate returned ${completed.output.length} embeddings for ${urls.length} inputs`,
      );
    }

    // andreasjansson/clip-features preserves input order in the output
    // array, but we still align by input string to be defensive against
    // any silent reordering.
    const byInput = new Map<string, number[]>();
    for (const entry of completed.output) {
      byInput.set(entry.input, entry.embedding);
    }

    return urls.map((url) => {
      const embedding = byInput.get(url);
      if (!embedding) {
        throw new ImageEmbedderRuntimeError(`Replicate response missing embedding for ${url}`);
      }
      if (embedding.length !== this.dimensions) {
        throw new ImageEmbedderRuntimeError(
          `Replicate returned embedding of dim ${embedding.length}, expected ${this.dimensions} for ${url}`,
        );
      }
      return embedding;
    });
  }

  private async createPrediction(inputsText: string): Promise<ReplicatePrediction> {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        prefer: "wait",
      },
      body: JSON.stringify({
        version: this.version,
        input: { inputs: inputsText },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ImageEmbedderRuntimeError(
        `Replicate prediction POST failed with ${response.status}: ${body.slice(0, 400)}`,
      );
    }

    return (await response.json()) as ReplicatePrediction;
  }

  private async awaitCompletion(initial: ReplicatePrediction): Promise<ReplicatePrediction> {
    if (initial.status === "succeeded" || initial.status === "failed" || initial.status === "canceled") {
      return initial;
    }

    const deadline = Date.now() + this.pollTimeoutMs;
    let current = initial;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      const response = await fetch(`https://api.replicate.com/v1/predictions/${current.id}`, {
        headers: { authorization: `Bearer ${this.token}` },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ImageEmbedderRuntimeError(
          `Replicate poll failed with ${response.status}: ${body.slice(0, 400)}`,
        );
      }

      current = (await response.json()) as ReplicatePrediction;

      if (current.status === "succeeded" || current.status === "failed" || current.status === "canceled") {
        return current;
      }
    }

    throw new ImageEmbedderRuntimeError(
      `Replicate prediction ${current.id} did not complete within ${this.pollTimeoutMs}ms (last status=${current.status})`,
    );
  }
}

// ─── Modal-hosted SigLIP-2 embedder ─────────────────────────────────
//
// Self-hosted on Modal serverless GPUs (memory-snapshot enabled) for
// sub-second cold starts. Replaces the broken-on-cold-start Replicate
// path for SigLIP. See cog/siglip-features/modal_app.py for the
// service implementation, MODAL.md for deploy instructions.
//
// Wire format mirrors andreasjansson/clip-features:
//   POST <endpoint>
//   Content-Type: application/json
//   { "auth": "<token>", "inputs": "url1\nurl2\n..." }
//   →
//   { "results": [{"input": "url1", "embedding": [...]}], ...,
//     "model_version": "siglip2-base-patch16-384-v1", "took_ms": ... }
//
// Auth is a token-in-body rather than a Bearer header so the Modal
// FastAPI integration stays simple. The wire is HTTPS, the endpoint
// is server-to-server (Vercel route ↔ Modal), and the token is
// rotated by re-running `modal secret create siglip2-features-token`.

type ModalSiglipResult = {
  input: string;
  embedding: number[] | null;
  error?: string;
};

type ModalSiglipResponse = {
  results: ModalSiglipResult[];
  model_version: string;
  took_ms?: number;
};

export class ModalSiglipEmbedder implements ImageEmbedder {
  public readonly modelVersion = IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP;
  public readonly dimensions = IMAGE_EMBEDDER_DIMENSIONS;

  private readonly endpointUrl: string;
  private readonly token: string;
  private readonly maxBatchSize: number;
  private readonly timeoutMs: number;

  constructor(opts: {
    endpointUrl: string;
    token: string;
    maxBatchSize?: number;
    timeoutMs?: number;
  }) {
    this.endpointUrl = opts.endpointUrl;
    this.token = opts.token;
    // Modal's snapshot-restored containers comfortably batch the same
    // ~16 images CLIP did, with similar T4 memory budget.
    this.maxBatchSize = opts.maxBatchSize ?? 16;
    // Cold start max ~10s on Modal; warm inference is sub-100ms.
    // 30s gives headroom for the worst-case cold start + slow URL
    // download inside the container.
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async embedUrls(urls: string[]): Promise<ImageEmbedResult[]> {
    if (urls.length === 0) return [];
    const out: ImageEmbedResult[] = urls.map(() => ({
      embedding: null,
      error: "unprocessed",
    }));

    for (let offset = 0; offset < urls.length; offset += this.maxBatchSize) {
      const chunk = urls.slice(offset, offset + this.maxBatchSize);
      try {
        const results = await this.invokeEndpoint(chunk);
        for (let i = 0; i < chunk.length; i += 1) {
          const r = results[i];
          if (r?.embedding) {
            out[offset + i] = { embedding: r.embedding, error: null };
          } else {
            out[offset + i] = { embedding: null, error: r?.error ?? "no embedding returned" };
          }
        }
      } catch (err) {
        const msg = err instanceof ImageEmbedderRuntimeError ? err.message : String(err);
        for (let i = 0; i < chunk.length; i += 1) {
          out[offset + i] = { embedding: null, error: msg.slice(0, 300) };
        }
      }
    }

    return out;
  }

  async embedBytes(bytes: Buffer, mimeType: string): Promise<number[]> {
    // Inline as a data URI — Modal endpoint handles both http(s) and
    // data: schemes. Same pattern the Cog model + Replicate model use.
    const dataUri = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const results = await this.invokeEndpoint([dataUri]);
    const item = results[0];
    if (!item?.embedding) {
      throw new ImageEmbedderRuntimeError(
        `Modal SigLIP embed failed: ${item?.error ?? "no embedding in response"}`,
      );
    }
    return item.embedding;
  }

  private async invokeEndpoint(sources: string[]): Promise<ModalSiglipResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth: this.token, inputs: sources.join("\n") }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new ImageEmbedderRuntimeError(
          `Modal endpoint ${response.status}: ${errBody.slice(0, 400)}`,
        );
      }

      const parsed = (await response.json()) as ModalSiglipResponse;
      if (!parsed?.results) {
        throw new ImageEmbedderRuntimeError(
          `Modal endpoint returned malformed body: ${JSON.stringify(parsed).slice(0, 400)}`,
        );
      }
      return parsed.results;
    } catch (err) {
      if (err instanceof ImageEmbedderRuntimeError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ImageEmbedderRuntimeError(`Modal endpoint fetch failed: ${msg}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function hasModalSiglipConfig(): boolean {
  return Boolean(
    process.env.MODAL_SIGLIP_ENDPOINT_URL?.trim() &&
    process.env.MODAL_SIGLIP_TOKEN?.trim(),
  );
}

export function getModalSiglipEmbedder(): ModalSiglipEmbedder {
  const endpointUrl = process.env.MODAL_SIGLIP_ENDPOINT_URL?.trim();
  const token = process.env.MODAL_SIGLIP_TOKEN?.trim();
  if (!endpointUrl) {
    throw new ImageEmbedderConfigError("Missing MODAL_SIGLIP_ENDPOINT_URL.");
  }
  if (!token) {
    throw new ImageEmbedderConfigError(
      "Missing MODAL_SIGLIP_TOKEN. Must match MODAL_INFERENCE_TOKEN secret on the Modal app.",
    );
  }
  return new ModalSiglipEmbedder({ endpointUrl, token });
}

// ─── Factory ────────────────────────────────────────────────────────
//
// Single entry point for the route. Picks CLIP or SigLIP based on the
// IMAGE_EMBEDDER_VARIANT env var. Default = "clip" (existing
// production path) so the cutover is opt-in via Vercel env config.
//
//   IMAGE_EMBEDDER_VARIANT=clip          → ReplicateClipEmbedder (default)
//   IMAGE_EMBEDDER_VARIANT=modal-siglip  → ModalSiglipEmbedder
//
// Rollback is symmetric: drop the env var or set it back to "clip".

export function getImageEmbedder(): ImageEmbedder {
  const variant = process.env.IMAGE_EMBEDDER_VARIANT?.trim();
  if (variant === "modal-siglip") {
    return getModalSiglipEmbedder();
  }
  return getReplicateClipEmbedder();
}
