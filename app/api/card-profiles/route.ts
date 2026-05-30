import { NextResponse } from "next/server";
import { loadCardProfileDetail } from "@/lib/card-profiles";

export const runtime = "nodejs";

function sanitizeSlug(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Public read. The AI card profile (summary_short / summary_long) is
// cron-generated, non-PII, per-card content derived from the public catalog —
// the same trust class as other public card data. Free AND signed-out users
// get it so the client-side free-analysis budget (3 distinct cards, device-
// scoped in PremiumGate) can actually reveal real content; that 3-card cap is
// a UX nudge, not a security boundary. (Was gated requireUser + hasPro, which
// silently made the "3 free analyses" feature non-functional for everyone but
// Pro — see CardDetailView's aiBriefSection.)
export async function GET(req: Request) {
  const slug = sanitizeSlug(new URL(req.url).searchParams.get("slug"));
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug query param." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      ok: true,
      slug,
      profile: await loadCardProfileDetail(slug),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, slug, error: toErrorMessage(error) }, { status: 500 });
  }
}
