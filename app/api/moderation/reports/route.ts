import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";
import {
  REPORT_REASONS,
  type ReportTargetKind,
  type ReportReason,
  type ReportSubmitResponse,
} from "@/lib/moderation/types";

export const runtime = "nodejs";

const TARGET_KINDS: ReportTargetKind[] = ["comment", "event", "profile", "profile_post"];

/**
 * POST /api/moderation/reports
 * Body: { target_kind, target_id, reason, details? }
 *
 * Append-only. Operators review via service-role; users can re-report
 * the same target (each report is a separate row, useful for triage).
 * Includes per-reporter rate limiting to prevent flood.
 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const targetKind = typeof body.target_kind === "string" ? body.target_kind : "";
  const targetIdRaw = body.target_id;
  let targetId =
    typeof targetIdRaw === "string"
      ? targetIdRaw.trim()
      : typeof targetIdRaw === "number"
        ? String(targetIdRaw)
        : "";
  const targetHandle = typeof body.target_handle === "string" ? body.target_handle.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  const details = typeof body.details === "string" ? body.details.trim() : "";

  if (!TARGET_KINDS.includes(targetKind as ReportTargetKind)) {
    return NextResponse.json(
      { ok: false, error: "Invalid target_kind." },
      { status: 400 },
    );
  }

  const db = await createServerSupabaseUserClient();

  // Profile reports may arrive with target_handle instead of target_id
  // (UserProfileView navigates by handle). Resolve before validating.
  if (!targetId && targetHandle && targetKind === "profile") {
    const { data } = await db.rpc("resolve_profile_handle", {
      desired_handle_norm: targetHandle.toLowerCase(),
    });
    targetId = typeof data === "string" ? data : "";
  }

  if (!targetId) {
    return NextResponse.json(
      { ok: false, error: "target_id is required." },
      { status: 400 },
    );
  }
  if (!REPORT_REASONS.includes(reason as ReportReason)) {
    return NextResponse.json(
      { ok: false, error: "Invalid reason." },
      { status: 400 },
    );
  }
  if (details.length > 500) {
    return NextResponse.json(
      { ok: false, error: "Details must be 500 characters or fewer." },
      { status: 400 },
    );
  }

  // Per-reporter flood guard: cap at 20 reports / 10 minutes.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from("moderation_reports")
    .select("id")
    .eq("reporter_id", auth.userId)
    .gte("created_at", tenMinAgo);

  if ((recent?.length ?? 0) >= 20) {
    return NextResponse.json(
      { ok: false, error: "Too many reports. Please try again later." },
      { status: 429 },
    );
  }

  // Resolve target_owner for operator triage. Best-effort: a missing
  // owner doesn't block the report.
  let targetOwner: string | null = null;
  if (targetKind === "comment") {
    const { data } = await db
      .from("activity_comments")
      .select("author_id")
      .eq("id", Number(targetId))
      .maybeSingle();
    targetOwner = (data as { author_id: string } | null)?.author_id ?? null;
  } else if (targetKind === "event") {
    const { data } = await db
      .from("activity_events")
      .select("actor_id")
      .eq("id", Number(targetId))
      .maybeSingle();
    targetOwner = (data as { actor_id: string } | null)?.actor_id ?? null;
  } else if (targetKind === "profile") {
    targetOwner = targetId;
  } else if (targetKind === "profile_post") {
    const { data } = await db
      .from("profile_posts")
      .select("author_id")
      .eq("id", Number(targetId))
      .maybeSingle();
    targetOwner = (data as { author_id: string } | null)?.author_id ?? null;
  }

  const { data: inserted, error } = await db
    .from("moderation_reports")
    .insert({
      reporter_id: auth.userId,
      target_kind: targetKind,
      target_id: targetId,
      target_owner: targetOwner,
      reason,
      details: details.length > 0 ? details : null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[moderation/reports POST]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const res: ReportSubmitResponse = { ok: true, id: inserted.id };
  return NextResponse.json(res);
}
