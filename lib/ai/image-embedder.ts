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
 * Tag shipped into card_image_embeddings.model_version. Bumped whenever
 * the underlying model or the pre-processing contract changes.
 */
export const IMAGE_EMBEDDER_MODEL_VERSION = "replicate-clip-vit-l-14-v1";

/** CLIP ViT-L/14 output dimensionality. Pinned — column is vector(768). */
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
