/**
 * Cron: check-embedder-health
 *
 * Hourly loud-failure probe of the active scanner image embedder
 * (the self-hosted home-GPU SigLIP server as of 2026-06). GETs
 * `<MODAL_SIGLIP_ENDPOINT_URL>/health` and returns 500 unless it
 * answers `{ok: true}` with the expected model_version — a failed
 * cron run in the Vercel dashboard is the alert, same pattern as
 * check-fx-rates-health.
 *
 * Why loud: the June 2026 Modal outage ran ~4 days undetected
 * because nothing probed the embedder — failures only surfaced at
 * scan time, and the (retired) keepwarm cron swallowed its own
 * errors. See docs/scanner-runbook.md, "Self-hosted embedder —
 * failure mode".
 *
 * Probe choice: GET /health (no inference) — deliberately NOT an
 * embed call, so this can never act as a keepwarm heartbeat if the
 * endpoint ever points back at scale-to-zero infrastructure. That
 * heartbeat-meets-warm-window interaction is what burned the Modal
 * credit pool.
 *
 * Skips clean when the active variant isn't modal-siglip — the
 * Replicate/CLIP rollback path has no /health surface to probe.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import {
  hasModalSiglipConfig,
  IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP,
} from "@/lib/ai/image-embedder";

export const runtime = "nodejs";
export const maxDuration = 30;

const PROBE_TIMEOUT_MS = 10_000;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const variant = process.env.IMAGE_EMBEDDER_VARIANT?.trim();
  if (variant !== "modal-siglip") {
    return NextResponse.json({
      ok: true,
      skipped: `active variant is ${variant || "clip (default)"} — no /health surface to probe`,
    });
  }

  // Mirror the identify route's config gate: hasModalSiglipConfig()
  // requires BOTH the endpoint URL and the token. A missing token
  // means the identify route rejects every scan (503) even though
  // the unauthenticated /health probe would still answer — the
  // watchdog must go red in that state too.
  const base = process.env.MODAL_SIGLIP_ENDPOINT_URL?.trim();
  if (!base || !hasModalSiglipConfig()) {
    const missing =
      ["MODAL_SIGLIP_ENDPOINT_URL", "MODAL_SIGLIP_TOKEN"]
        .filter((key) => !process.env[key]?.trim())
        .join(", ") || "MODAL_SIGLIP_* config";
    return NextResponse.json(
      {
        ok: false,
        healthy: false,
        reason: `IMAGE_EMBEDDER_VARIANT=modal-siglip but ${missing} unset — the identify route rejects all scans in this state`,
      },
      { status: 500 },
    );
  }

  const healthUrl = `${base.replace(/\/+$/, "")}/health`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, {
      signal: controller.signal,
      cache: "no-store",
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          healthy: false,
          reason: `health endpoint returned HTTP ${res.status}`,
          duration_ms: durationMs,
        },
        { status: 500 },
      );
    }

    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      model_version?: string;
      device?: string;
    } | null;

    if (!body?.ok) {
      return NextResponse.json(
        {
          ok: false,
          healthy: false,
          reason:
            "health endpoint answered but reported ok=false (model not loaded?)",
          body,
          duration_ms: durationMs,
        },
        { status: 500 },
      );
    }

    if (body.model_version !== IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP) {
      return NextResponse.json(
        {
          ok: false,
          healthy: false,
          reason: `model_version mismatch: server reports ${body.model_version ?? "none"}, expected ${IMAGE_EMBEDDER_MODEL_VERSION_SIGLIP}`,
          duration_ms: durationMs,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      healthy: true,
      model_version: body.model_version,
      device: body.device ?? null,
      duration_ms: durationMs,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        healthy: false,
        reason: `health probe failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
