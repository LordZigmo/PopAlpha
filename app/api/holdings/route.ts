import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

// Uses dbAdmin() because the iOS app sends a Clerk Bearer JWT that
// Supabase RLS cannot validate (no JWT template configured). Since
// requireUser() already verifies identity and every query filters
// by owner_clerk_id, this is equivalent in security to RLS.

// ── GET /api/holdings — list authenticated user's holdings ──────────────────

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("holdings")
    .select("id, canonical_slug, printing_id, grade, qty, price_paid_usd, acquired_on, venue, cert_number, source")
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
  const auth = await requireUser(req);
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
  // price_paid_usd is optional — users often don't remember what they
  // paid for older cards. NULL means "unknown cost basis" rather than
  // "paid $0", so we preserve that distinction all the way through.
  const price_paid_usd =
    typeof body.price_paid_usd === "number" ? body.price_paid_usd : null;
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
  // Only validate when the user actually provided a price. Null is
  // fine — "I don't remember".
  if (price_paid_usd !== null && price_paid_usd < 0) {
    return NextResponse.json({ ok: false, error: "price_paid_usd must be >= 0." }, { status: 400 });
  }

  const supabase = dbAdmin();
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

// ── PATCH /api/holdings — partial update of an existing lot ────────────────
//
// Accepts { id, ...changes }. Every field other than id is optional;
// presence (including explicit null for price_paid_usd) means "set to
// this value", absence means "leave untouched". Scoped by owner_clerk_id
// so a user can't patch a row they don't own even if they guess an id.

export async function PATCH(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  // holdings.id is a UUID column. Accept the string directly. Tolerate
  // a number coming in from older clients by stringifying it — the
  // database will still reject anything that isn't a real UUID.
  const id =
    typeof body.id === "string" ? body.id.trim()
      : typeof body.id === "number" ? String(body.id)
      : "";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "id must be a UUID string." }, { status: 400 });
  }

  // Build the update payload out of only the keys the caller actually
  // sent. `"price_paid_usd" in body` distinguishes "field omitted"
  // (leave alone) from "field set to null" (clear cost basis).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: Record<string, any> = {};

  if ("grade" in body) {
    if (typeof body.grade !== "string" || !body.grade.trim()) {
      return NextResponse.json({ ok: false, error: "grade must be a non-empty string." }, { status: 400 });
    }
    update.grade = body.grade.trim();
  }

  if ("qty" in body) {
    if (typeof body.qty !== "number" || !Number.isFinite(body.qty) || body.qty < 1) {
      return NextResponse.json({ ok: false, error: "qty must be a positive integer." }, { status: 400 });
    }
    update.qty = Math.floor(body.qty);
  }

  if ("price_paid_usd" in body) {
    if (body.price_paid_usd === null) {
      update.price_paid_usd = null;
    } else if (typeof body.price_paid_usd === "number" && body.price_paid_usd >= 0) {
      update.price_paid_usd = body.price_paid_usd;
    } else {
      return NextResponse.json(
        { ok: false, error: "price_paid_usd must be a non-negative number or null." },
        { status: 400 },
      );
    }
  }

  if ("acquired_on" in body) {
    if (body.acquired_on === null || body.acquired_on === "") {
      update.acquired_on = null;
    } else if (typeof body.acquired_on === "string") {
      update.acquired_on = body.acquired_on;
    } else {
      return NextResponse.json(
        { ok: false, error: "acquired_on must be a date string or null." },
        { status: 400 },
      );
    }
  }

  if ("venue" in body) {
    if (body.venue === null || body.venue === "") {
      update.venue = null;
    } else if (typeof body.venue === "string") {
      update.venue = body.venue.trim() || null;
    } else {
      return NextResponse.json({ ok: false, error: "venue must be a string or null." }, { status: 400 });
    }
  }

  if ("cert_number" in body) {
    if (body.cert_number === null || body.cert_number === "") {
      update.cert_number = null;
    } else if (typeof body.cert_number === "string") {
      update.cert_number = body.cert_number.trim() || null;
    } else {
      return NextResponse.json(
        { ok: false, error: "cert_number must be a string or null." },
        { status: 400 },
      );
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { ok: false, error: "No updatable fields provided." },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();
  const { error, count } = await supabase
    .from("holdings")
    .update(update, { count: "exact" })
    .eq("id", id)
    .eq("owner_clerk_id", auth.userId);

  if (error) {
    console.error("[holdings PATCH]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
  if ((count ?? 0) === 0) {
    // Row didn't exist OR belonged to another user. 404 rather than 403
    // so we don't leak existence of other users' rows.
    return NextResponse.json({ ok: false, error: "Holding not found." }, { status: 404 });
  }

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: auth.userId,
    event: "holding_edited",
    properties: { holding_id: id, fields_updated: Object.keys(update) },
  });

  return NextResponse.json({ ok: true });
}

// ── DELETE /api/holdings?ids=1,2,3 — remove lots from the portfolio ─────────
//
// Accepts a comma-separated list of holding row IDs via the `ids` query
// param. All IDs are scoped to the authenticated user so callers cannot
// delete rows they don't own even if they guess an id.

export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawIds = url.searchParams.get("ids") ?? "";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && UUID_RE.test(s));

  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "ids query param required (UUIDs)." }, { status: 400 });
  }

  const supabase = dbAdmin();
  const { error, count } = await supabase
    .from("holdings")
    .delete({ count: "exact" })
    .in("id", ids)
    .eq("owner_clerk_id", auth.userId);

  if (error) {
    console.error("[holdings DELETE]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: auth.userId,
    event: "holding_deleted",
    properties: { holding_ids: ids, count: count ?? ids.length },
  });

  return NextResponse.json({ ok: true, deleted: count ?? ids.length });
}
