import { NextResponse } from "next/server";
import { requireOnboarded } from "@/lib/auth/require";
import { createServerSupabaseUserClient } from "@/lib/db/user";

export const runtime = "nodejs";

// ── GET /api/holdings — list authenticated user's holdings ──────────────────

export async function GET(req: Request) {
  const auth = await requireOnboarded(req);
  if (!auth.ok) return auth.response;

  const supabase = await createServerSupabaseUserClient();
  const { data, error } = await supabase
    .from("holdings")
    .select("id, canonical_slug, printing_id, grade, qty, price_paid_usd, acquired_on, venue, cert_number")
    .eq("owner_clerk_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[holdings GET]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, holdings: data });
}

// ── POST /api/holdings — add a lot for the authenticated user ───────────────

export async function POST(req: Request) {
  const auth = await requireOnboarded(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  // Input validation
  const canonical_slug = typeof body.canonical_slug === "string" ? body.canonical_slug.trim() : "";
  const printing_id = typeof body.printing_id === "string" ? body.printing_id.trim() || null : null;
  const grade = typeof body.grade === "string" ? body.grade.trim() : "";
  const qty = typeof body.qty === "number" ? Math.floor(body.qty) : 0;
  const price_paid_usd = typeof body.price_paid_usd === "number" ? body.price_paid_usd : -1;
  const acquired_on = typeof body.acquired_on === "string" && body.acquired_on ? body.acquired_on : null;
  const venue = typeof body.venue === "string" && body.venue ? body.venue.trim() : null;
  const cert_number = typeof body.cert_number === "string" && body.cert_number.trim()
    ? body.cert_number.trim()
    : null;

  if (!canonical_slug) {
    return NextResponse.json({ ok: false, error: "canonical_slug is required." }, { status: 400 });
  }
  if (!grade) {
    return NextResponse.json({ ok: false, error: "grade is required." }, { status: 400 });
  }
  if (qty < 1) {
    return NextResponse.json({ ok: false, error: "qty must be at least 1." }, { status: 400 });
  }
  if (price_paid_usd < 0) {
    return NextResponse.json({ ok: false, error: "price_paid_usd must be >= 0." }, { status: 400 });
  }

  const supabase = await createServerSupabaseUserClient();
  const { error } = await supabase.from("holdings").insert({
    owner_clerk_id: auth.userId,
    canonical_slug,
    printing_id,
    grade,
    qty,
    price_paid_usd,
    acquired_on,
    venue,
    cert_number,
  });

  if (error) {
    console.error("[holdings POST]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
