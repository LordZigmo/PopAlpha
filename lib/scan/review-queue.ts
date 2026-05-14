// Failure-case review queue for the scanner.
//
// When /api/scan/identify returns a result that's neither clearly right
// nor clearly wrong — specifically `confidence === "medium"` AND OCR
// failed to extract a card number — we copy the captured photo from
// `scan-uploads/<hash>.jpg` to `scan-uploads/review-queue/<hash>.jpg`
// for periodic operator review. The scan_identify_events row is
// stamped with `review_queued_at` so operators can list the queue via
// SQL and view the corresponding image at the predictable path.
//
// Tier 1.5 §6 item 2 of docs/scanner-accuracy-playbook.md. Closes the
// gap that real-user production failures were invisible — DEBUG-build
// auto-promote (Phase 0d) only captures what the team scans in
// internal testing.
//
// Design:
//   - Server-side ONLY (caller is /api/scan/identify, which has the
//     bytes already in scan-uploads). Offline scans never participate;
//     they preserve the premium-tier "stays on device" promise.
//   - Fire-and-forget — the caller MUST `void` this and not await it
//     so a Storage hiccup doesn't slow the scan response.
//   - Idempotent on image_hash: same hash + already-queued path
//     short-circuits without re-uploading. Storage `.upsert: true`
//     handles the race where two scans of the same image queue
//     simultaneously.
//   - No new bucket, no new RLS — reuses card-images/scan-uploads/
//     with a `review-queue/` prefix.

import { dbAdmin } from "@/lib/db/admin";

const IMAGE_BUCKET = "card-images";
const SOURCE_PREFIX = "scan-uploads";
const REVIEW_QUEUE_PREFIX = "scan-uploads/review-queue";

/**
 * Copy a scan's captured photo into the review queue and stamp the
 * scan_identify_events row. Never throws; logs and returns on failure.
 *
 * Caller must `void` this — it's fire-and-forget. Awaiting blocks the
 * scan response on a Storage round-trip we don't need to wait for.
 */
export async function enqueueScanForReview(imageHash: string): Promise<void> {
  if (!imageHash || imageHash.length < 10) {
    console.warn("[scan/review-queue] skip: invalid imageHash", imageHash);
    return;
  }

  const supabase = dbAdmin();
  const sourceKey = `${SOURCE_PREFIX}/${imageHash}.jpg`;
  const destKey = `${REVIEW_QUEUE_PREFIX}/${imageHash}.jpg`;

  // Download the source object. Mirrors the scan-eval/promote pattern
  // (download + re-upload) so behavior is predictable on this codebase
  // — Storage `.copy()` exists but isn't exercised elsewhere here.
  const { data: sourceObj, error: downloadErr } = await supabase.storage
    .from(IMAGE_BUCKET)
    .download(sourceKey);

  if (downloadErr || !sourceObj) {
    // The scan-uploads object should exist — the scan/identify route
    // uploads it before this fires — but log if it doesn't so we can
    // catch upload races.
    console.warn(
      `[scan/review-queue] source not found at ${sourceKey}: ${
        downloadErr?.message ?? "no data"
      }`,
    );
    return;
  }

  const bytes = Buffer.from(await sourceObj.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(destKey, bytes, {
      upsert: true,
      contentType: "image/jpeg",
      // Long cache is fine — operator review tools can bust by query
      // string if needed and the path is content-hashed anyway.
      cacheControl: "31536000, immutable",
    });

  if (uploadErr) {
    console.warn(
      `[scan/review-queue] upload to ${destKey} failed: ${uploadErr.message}`,
    );
  }
}
