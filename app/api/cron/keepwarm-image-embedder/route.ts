/**
 * Cron: keepwarm-image-embedder
 *
 * Keeps the Replicate CLIP model container warm so user scans don't pay
 * cold-start latency (5-10s instead of 1-3s). Replicate spins down idle
 * containers after ~5-10 min; we fire one no-op embedding every 4 min
 * so the warm window never closes.
 *
 * Cost: ~15 calls/hour × 24 × 30 ≈ 10,800/mo × ~$0.0003 ≈ $3/mo.
 * Cheap enough that the zero-cold-start UX is worth it unconditionally.
 *
 * Skip conditions:
 *   - If REPLICATE_* env vars aren't set, early-exit clean.
 *   - If no canonical_cards rows have a mirrored URL to use as the probe
 *     image, early-exit clean (nothing to embed against anyway).
 *
 * Never writes to scan_identify_events. This is embedder-warmup, not a
 * user scan — polluting the telemetry would make confidence-tier and
 * duration percentile metrics meaningless.
 *
 * Worth retiring when we migrate to a self-hosted always-on embedder
 * (see memory: project_scanner_self_hosted_failover).
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  getReplicateClipEmbedder,
  hasReplicateConfig,
  ImageEmbedderConfigError,
  ImageEmbedderRuntimeError,
} from "@/lib/ai/image-embedder";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (!hasReplicateConfig()) {
    return NextResponse.json(
      { ok: true, skipped: "replicate_not_configured" },
      { status: 200 },
    );
  }

  // Pick any mirrored image as the warmup probe. We don't care which —
  // its only job is to make Replicate keep the GPU container loaded.
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("mirrored_primary_image_url")
    .not("mirrored_primary_image_url", "is", null)
    .order("slug", { ascending: true })
    .limit(1);

  if (error) {
    return NextResponse.json(
      { ok: false, error: `Supabase select failed: ${error.message}` },
      { status: 500 },
    );
  }

  const probeUrl = (data ?? [])[0]?.mirrored_primary_image_url as string | undefined;
  if (!probeUrl) {
    return NextResponse.json(
      { ok: true, skipped: "no_mirrored_url_available" },
      { status: 200 },
    );
  }

  let embedder;
  try {
    embedder = getReplicateClipEmbedder();
  } catch (err) {
    if (err instanceof ImageEmbedderConfigError) {
      return NextResponse.json({ ok: true, skipped: err.message }, { status: 200 });
    }
    throw err;
  }

  const startedAt = Date.now();
  try {
    const results = await embedder.embedUrls([probeUrl]);
    const durationMs = Date.now() - startedAt;
    const first = results[0];
    const ok = first?.embedding !== null && first?.embedding !== undefined;

    return NextResponse.json({
      ok: true,
      warmed: ok,
      duration_ms: durationMs,
      model_version: embedder.modelVersion,
      error: first?.error ?? null,
    });
  } catch (err) {
    if (err instanceof ImageEmbedderRuntimeError) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          duration_ms: Date.now() - startedAt,
          model_version: embedder.modelVersion,
        },
        { status: 502 },
      );
    }
    throw err;
  }
}
