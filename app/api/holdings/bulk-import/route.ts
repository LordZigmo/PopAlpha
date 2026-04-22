import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { getPostHogClient } from "@/lib/posthog-server";

// Bulk-import holdings from a CSV parsed client-side.
//
// The iOS BulkImportPreviewSheet resolves card names → canonical slugs
// via SearchService before hitting this endpoint, so by the time rows
// arrive here every one is expected to have a valid canonical_slug.
// Server validates the shape, hard-caps row count at MAX_ROWS so a
// misbehaving client can't wedge a transaction, and inserts everything
// in a single Supabase call. Per-row errors are returned alongside the
// success count so users see exactly which rows landed and which
// didn't (instead of "all-or-nothing").
//
// Same dbAdmin() + manual owner_clerk_id scoping pattern the rest of
// /api/holdings uses — consistent with POST/PATCH in the parent route.

export const runtime = "nodejs";

const MAX_ROWS = 500;

type InputRow = {
  canonical_slug?: unknown;
  printing_id?: unknown;
  grade?: unknown;
  qty?: unknown;
  price_paid_usd?: unknown;
  acquired_on?: unknown;
  venue?: unknown;
  cert_number?: unknown;
};

type RowError = { row_index: number; error: string };
type InsertPayload = {
  owner_clerk_id: string;
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  qty: number;
  price_paid_usd: number | null;
  acquired_on: string | null;
  venue: string | null;
  cert_number: string | null;
  source: "csv_import";
};

function toStringOrNull(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || null;
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const rawRows = body.rows;
  if (!Array.isArray(rawRows)) {
    return NextResponse.json(
      { ok: false, error: "rows must be an array." },
      { status: 400 },
    );
  }
  if (rawRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No rows provided." },
      { status: 400 },
    );
  }
  if (rawRows.length > MAX_ROWS) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many rows (${rawRows.length}). Max per import is ${MAX_ROWS}. Split into multiple imports.`,
      },
      { status: 400 },
    );
  }

  // Validate + normalize each row. Bad rows are rejected individually
  // so a typo on row 37 doesn't prevent rows 1–36 from importing.
  const toInsert: InsertPayload[] = [];
  const errors: RowError[] = [];

  (rawRows as InputRow[]).forEach((row, index) => {
    const canonical_slug = toStringOrNull(row.canonical_slug, 200);
    const grade = toStringOrNull(row.grade, 32);
    const qty = typeof row.qty === "number" ? Math.floor(row.qty) : NaN;

    if (!canonical_slug) {
      errors.push({ row_index: index, error: "Missing canonical_slug." });
      return;
    }
    if (!grade) {
      errors.push({ row_index: index, error: "Missing grade." });
      return;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      errors.push({ row_index: index, error: "qty must be a positive integer." });
      return;
    }

    let price_paid_usd: number | null = null;
    if (row.price_paid_usd !== undefined && row.price_paid_usd !== null) {
      if (typeof row.price_paid_usd !== "number" || row.price_paid_usd < 0) {
        errors.push({
          row_index: index,
          error: "price_paid_usd must be a non-negative number or null.",
        });
        return;
      }
      price_paid_usd = row.price_paid_usd;
    }

    toInsert.push({
      owner_clerk_id: auth.userId,
      canonical_slug,
      printing_id: toStringOrNull(row.printing_id, 200),
      grade,
      qty,
      price_paid_usd,
      acquired_on: toStringOrNull(row.acquired_on, 32),
      venue: toStringOrNull(row.venue, 128),
      cert_number: toStringOrNull(row.cert_number, 64),
      // Every row inserted through this endpoint is flagged so the iOS
      // client can surface a subtle "Imported" chip on those lots.
      source: "csv_import",
    });
  });

  if (toInsert.length === 0) {
    return NextResponse.json(
      { ok: false, inserted: 0, errors, error: "No valid rows to import." },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();
  const { error, count } = await supabase
    .from("holdings")
    .insert(toInsert, { count: "exact" });

  if (error) {
    console.error("[holdings/bulk-import]", error.message);
    return NextResponse.json(
      {
        ok: false,
        inserted: 0,
        errors: [
          ...errors,
          { row_index: -1, error: `Database error: ${error.message}` },
        ],
      },
      { status: 400 },
    );
  }

  const insertedCount = count ?? toInsert.length;

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: auth.userId,
    event: "holdings_bulk_imported",
    properties: {
      rows_submitted: rawRows.length,
      rows_inserted: insertedCount,
      rows_errored: errors.length,
    },
  });

  return NextResponse.json({
    ok: true,
    inserted: insertedCount,
    errors,
  });
}
