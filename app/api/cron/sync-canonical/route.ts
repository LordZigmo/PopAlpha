/**
 * Cron: sync-canonical
 *
 * Intentionally paused unless legacy provider-driven canonical import is
 * explicitly re-enabled. Canonical identity should come from the canonical
 * source of truth, not from Scrydex provider payloads.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";

export const maxDuration = 300;

const PAGES_PER_RUN = 10;
const PAGE_SIZE = 100;
const JOB = "scrydex_canonical_import";

type LastRunRow = {
  items_fetched: number;
  meta: Record<string, unknown> | null;
};

function resolveBaseUrl(): string {
  // VERCEL_PROJECT_PRODUCTION_URL is the stable prod URL (Pro+).
  // VERCEL_URL is the deployment URL (set on all plans, but may be preview).
  // Fall back to localhost for local dev.
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const deployment = process.env.VERCEL_URL;
  const host = prod ?? deployment;
  return host ? `https://${host}` : "http://localhost:3000";
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (process.env.ALLOW_PROVIDER_CANONICAL_IMPORT !== "1") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "provider_canonical_import_disabled",
    });
  }

  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (!adminSecret) {
    return NextResponse.json(
      { ok: false, error: "ADMIN_SECRET env var is not configured." },
      { status: 500 }
    );
  }

  // ── Determine which page to start on ─────────────────────────────────────
  const supabase = dbAdmin();

  const { data: lastRun } = await supabase
    .from("ingest_runs")
    .select("items_fetched, meta")
    .eq("job", JOB)
    .eq("status", "finished")
    .eq("ok", true)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle<LastRunRow>();

  const lastItemsFetched = lastRun?.items_fetched ?? 0;
  const lastMeta = lastRun?.meta ?? null;
  const lastPageProcessed =
    typeof lastMeta?.pageLastProcessed === "number" ? lastMeta.pageLastProcessed : 0;

  // If the previous run fetched 0 cards the catalog is exhausted — restart.
  const pageStart = lastItemsFetched === 0 ? 1 : lastPageProcessed + 1;

  // ── Call the canonical importer ───────────────────────────────────────────
  const baseUrl = resolveBaseUrl();
  const params = new URLSearchParams({
    pageStart: String(pageStart),
    maxPages: String(PAGES_PER_RUN),
    pageSize: String(PAGE_SIZE),
  });

  let importResult: Record<string, unknown>;
  try {
    const response = await fetch(
      `${baseUrl}/api/admin/import/scrydex-canonical?${params.toString()}`,
      {
        method: "POST",
        headers: { "x-admin-secret": adminSecret },
      }
    );
    importResult = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({
    ok: importResult.ok ?? false,
    pageStart,
    pagesPerRun: PAGES_PER_RUN,
    ...importResult,
  });
}
