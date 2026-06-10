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
  client_lot_id?: unknown;
};

type RowError = { row_index: number; error: string };
type HoldingsSource = "csv_import" | "scanner";

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
  source: HoldingsSource;
  /**
   * Idempotency key. Client-supplied (iOS MultiScanEntry.id) on scanner
   * imports so a retried chunk whose earlier POST committed but whose
   * response was lost upserts to a no-op instead of duplicating the
   * lot; server-minted UUID for clients that don't send one (uniform
   * keys keep PostgREST bulk insert happy, and an unknown-to-the-client
   * key can never match a retry).
   */
  client_lot_id: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the holdings.source CHECK constraint from
// supabase/migrations/20260421200152_holdings_source.sql which allows
// ('manual', 'csv_import', 'scanner'). 'manual' is reserved for the
// single-row POST /api/holdings path; this route only emits the two
// non-manual values. Unknown / missing source falls back to csv_import
// for back-compat with the original CSV preview client.
const ALLOWED_SOURCES: ReadonlyArray<HoldingsSource> = ["csv_import", "scanner"];

function parseSource(raw: unknown): HoldingsSource {
  if (typeof raw !== "string") return "csv_import";
  return (ALLOWED_SOURCES as ReadonlyArray<string>).includes(raw)
    ? (raw as HoldingsSource)
    : "csv_import";
}

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
  // Multi-scan tray submits with `source: "scanner"` so holdings.source
  // tags scan-derived lots distinctly from CSV imports. Unknown values
  // fall back to csv_import (back-compat for the original preview
  // client) — strictness lives at the parser so a future client bug
  // can't poison the DB CHECK constraint.
  const source: HoldingsSource = parseSource(body.source);
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

    // Optional idempotency key. Malformed values are a per-row error
    // rather than silently dropped — a client that THINKS it sent a key
    // but didn't would lose its retry protection without noticing.
    let client_lot_id: string | undefined;
    if (row.client_lot_id !== undefined && row.client_lot_id !== null) {
      if (typeof row.client_lot_id !== "string" || !UUID_PATTERN.test(row.client_lot_id)) {
        errors.push({
          row_index: index,
          error: "client_lot_id must be a UUID when provided.",
        });
        return;
      }
      client_lot_id = row.client_lot_id.toLowerCase();
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
      // Sourced from the request body — falls back to "csv_import"
      // when the client omits source (legacy CSV preview) or sends an
      // unrecognized value. Every row in a given submission shares the
      // same source: the bulk-import endpoint is intended for one
      // homogeneous import at a time.
      source,
      // Always populated: PostgREST bulk inserts require uniform keys
      // across rows, so rather than relying on the DB default for rows
      // that omit the key (which would 400 a mixed batch), mint a
      // server-side UUID. Server-minted keys are unknown to the client
      // and therefore never match a retry — identical to default
      // semantics.
      client_lot_id: client_lot_id ?? crypto.randomUUID(),
    });
  });

  if (toInsert.length === 0) {
    return NextResponse.json(
      { ok: false, inserted: 0, errors, error: "No valid rows to import." },
      { status: 400 },
    );
  }

  const supabase = dbAdmin();
  // Upsert with ignore-duplicates against the (owner_clerk_id,
  // client_lot_id) unique constraint: a retried chunk whose earlier
  // POST committed server-side (timeout / lost response) no-ops with
  // inserted=0 instead of duplicating the user's lots. Rows without a
  // client key get a fresh server-side UUID via the column default and
  // can never conflict, so legacy clients keep plain-insert semantics.
  let { error, count } = await supabase
    .from("holdings")
    .upsert(toInsert, {
      onConflict: "owner_clerk_id,client_lot_id",
      ignoreDuplicates: true,
      count: "exact",
    });

  // Migration-lag compatibility (Codex P1 on PR #218): the app deploy
  // and the supabase-migrations workflow start in parallel on merge,
  // and Vercel preview deploys share the production DB — so this code
  // can run against a schema that doesn't have client_lot_id yet.
  // When the error is specifically "schema doesn't know that column /
  // constraint" (PGRST204 = column missing from PostgREST's schema
  // cache, 42703 = undefined column, 42P10 = no matching ON CONFLICT
  // constraint), retry as a legacy plain insert without the key —
  // identical to pre-migration behavior, idempotency simply not yet
  // active. Any other error keeps the original failure path.
  if (error && ["PGRST204", "42703", "42P10"].includes(error.code ?? "")) {
    console.warn(
      "[holdings/bulk-import] client_lot_id schema not present yet; falling back to legacy insert",
      { code: error.code },
    );
    const legacyRows = toInsert.map(({ client_lot_id: _omitted, ...rest }) => rest);
    ({ error, count } = await supabase
      .from("holdings")
      .insert(legacyRows, { count: "exact" }));
  }

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
