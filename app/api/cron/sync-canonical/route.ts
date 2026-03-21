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
import { runScrydexCanonicalImport } from "@/lib/admin/scrydex-canonical-import";

export const runtime = "nodejs";

export const maxDuration = 300;

const PAGES_PER_RUN = 10;
const PAGE_SIZE = 100;
const JOB = "scrydex_canonical_import";

type LastRunRow = {
  items_fetched: number;
  meta: Record<string, unknown> | null;
};

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

  const importResult = await runScrydexCanonicalImport({
    pageStart,
    maxPages: PAGES_PER_RUN,
    pageSize: PAGE_SIZE,
    expansionId: null,
    dryRun: false,
  });

  return NextResponse.json({
    ok: importResult.body.ok ?? false,
    pageStart,
    pagesPerRun: PAGES_PER_RUN,
    ...importResult.body,
  }, { status: importResult.status });
}
