/**
 * Cron: sync-canonical
 *
 * Runs daily (vercel.json: "0 4 * * *") and pages through the full PokémonTCG
 * card catalog, upsetting canonical_cards + card_printings so "Unknown" fields
 * get filled in automatically over time.
 *
 * Cursor strategy: reads the last page processed from `ingest_runs.meta` so
 * each run continues where the previous one left off. When the catalog end is
 * reached (items_fetched === 0), restarts from page 1 for a fresh full pass.
 *
 * At 2 pages × 250 cards per run the full ~20 k-card catalog cycles in ≈ 40 days;
 * afterwards it keeps refreshing indefinitely.
 */

import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

export const maxDuration = 300;

const PAGES_PER_RUN = 10;
const PAGE_SIZE = 250;
const JOB = "pokemontcg_canonical_import";

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
  // Vercel sends the CRON_SECRET as a Bearer token when invoking cron routes.
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (!adminSecret) {
    return NextResponse.json(
      { ok: false, error: "ADMIN_SECRET env var is not configured." },
      { status: 500 }
    );
  }

  // ── Determine which page to start on ─────────────────────────────────────
  const supabase = getServerSupabaseClient();

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
      `${baseUrl}/api/admin/import/pokemontcg-canonical?${params.toString()}`,
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
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    pageStart,
    pagesPerRun: PAGES_PER_RUN,
    ...importResult,
  });
}
