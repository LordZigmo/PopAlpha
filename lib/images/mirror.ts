import "server-only";

import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";

export const IMAGE_BUCKET = "card-images";
const THUMB_WIDTH = 256;
const THUMB_QUALITY = 82;
const FETCH_TIMEOUT_MS = 15_000;

export type MirroredUrls = {
  fullUrl: string;
  thumbUrl: string;
};

/**
 * Download `sourceUrl`, generate a WebP thumbnail, upload both to the
 * `card-images` Supabase Storage bucket under `storageKey`, and return
 * the public URLs.
 *
 * - Full variant is stored as `<storageKey>/full.<ext>` using the source
 *   content type (typically image/png from Scrydex).
 * - Thumb variant is always `<storageKey>/thumb.webp` at THUMB_WIDTH.
 *
 * Uses `upsert: true` so a re-run of the cron worker on the same row
 * (e.g. to refresh a changed upstream image) is idempotent.
 *
 * `client` must be a service-role Supabase client (the storage bucket
 * writes bypass RLS). The caller supplies it rather than this module
 * importing `dbAdmin` directly so the library stays free of privileged
 * coupling and remains usable from tests.
 */
export async function mirrorImage(
  sourceUrl: string,
  storageKey: string,
  client: SupabaseClient,
): Promise<MirroredUrls> {
  const res = await fetchWithTimeout(sourceUrl, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`fetch ${sourceUrl} failed: ${res.status} ${res.statusText}`);
  }
  const sourceContentType = res.headers.get("content-type") ?? "image/png";
  const fullBuf = Buffer.from(await res.arrayBuffer());

  const thumbBuf = await sharp(fullBuf)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  const fullExt = extensionForContentType(sourceContentType);
  const fullKey = `${storageKey}/full.${fullExt}`;
  const thumbKey = `${storageKey}/thumb.webp`;

  const [fullUp, thumbUp] = await Promise.all([
    client.storage.from(IMAGE_BUCKET).upload(fullKey, fullBuf, {
      upsert: true,
      contentType: sourceContentType,
      cacheControl: "31536000, immutable",
    }),
    client.storage.from(IMAGE_BUCKET).upload(thumbKey, thumbBuf, {
      upsert: true,
      contentType: "image/webp",
      cacheControl: "31536000, immutable",
    }),
  ]);
  if (fullUp.error) throw new Error(`upload full failed: ${fullUp.error.message}`);
  if (thumbUp.error) throw new Error(`upload thumb failed: ${thumbUp.error.message}`);

  const fullUrl = client.storage.from(IMAGE_BUCKET).getPublicUrl(fullKey).data.publicUrl;
  const thumbUrl = client.storage.from(IMAGE_BUCKET).getPublicUrl(thumbKey).data.publicUrl;
  return { fullUrl, thumbUrl };
}

/** Slugify a uuid or text into a safe storage path segment. */
function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/** Storage key for a `card_printings` row. */
export function printingStorageKey(source: string, sourceId: string | null, fallbackId: string): string {
  const tail = sourceId ? safePathSegment(sourceId) : safePathSegment(fallbackId);
  return `printings/${safePathSegment(source)}/${tail}`;
}

/** Storage key for a `canonical_cards` row. */
export function canonicalStorageKey(slug: string): string {
  return `canonical/${safePathSegment(slug)}`;
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "bin";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
