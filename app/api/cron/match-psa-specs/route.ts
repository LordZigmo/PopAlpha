/**
 * Cron: match-psa-specs
 *
 * Daily sweep of the PSA SpecID → catalog mapping (Population Tables
 * Phase 2, docs/psa-specid-mapping-handoff.md). New specs are matched
 * inline as the slab scanner harvests them (app/api/psa/cert/route.ts);
 * this sweep is the self-healing backstop: it retries UNMATCHED specs as
 * psa_set_map curation lands and the catalog grows, and catches any spec
 * whose inline attempt was skipped or timed out. DB-only — spends zero
 * PSA API quota.
 *
 * Manual modes:
 *   ?specId=12345        match one spec (still persisted)
 *   ?force=1             re-decide already-MATCHED specs (verified rows
 *                        are never touched)
 *   ?dryRun=1            decide without persisting
 *   ?limit=200           cap specs processed this run (default 500)
 *   ?mode=report         no matching: returns the audit artifact —
 *                        match-rate, confidence distribution, queue
 *                        breakdown, and random samples for human
 *                        spot-checks against psacard.com.
 *
 * Failure semantics: UNMATCHED specs are a valid, expected state (the
 * review queue), not a failure. The run only 500s when the runner itself
 * errors (DB/RPC failure) so Vercel cron alerting fires on plumbing
 * breakage, not on data conditions.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { runPsaSpecMatch } from "@/lib/backfill/psa-spec-match";

export const runtime = "nodejs";
export const maxDuration = 300;

const REPORT_SCAN_CAP = 2000;
const REPORT_SAMPLE_SIZE = 10;

type ReportMapRow = {
  spec_id: number;
  canonical_slug: string | null;
  printing_id: string | null;
  mapping_status: "MATCHED" | "UNMATCHED";
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  verified: boolean;
  updated_at: string | null;
};

function sampleRows<T>(rows: T[], count: number): T[] {
  const pool = [...rows];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(index, 1)[0]!);
  }
  return out;
}

function confidenceBucket(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "none";
  if (value >= 0.98) return ">=0.98";
  if (value >= 0.95) return "0.95-0.98";
  if (value >= 0.9) return "0.90-0.95";
  return "<0.90";
}

async function buildReport() {
  const supabase = dbAdmin();

  const [{ count: targetsTotal, error: targetsError }, mapRes] = await Promise.all([
    supabase
      .from("psa_spec_targets")
      .select("spec_id", { count: "exact", head: true }),
    supabase
      .from("psa_spec_card_map")
      .select(
        "spec_id, canonical_slug, printing_id, mapping_status, match_type, match_confidence, match_reason, verified, updated_at",
      )
      .order("spec_id", { ascending: true })
      .limit(REPORT_SCAN_CAP),
  ]);
  if (targetsError) throw new Error(`psa_spec_targets(count): ${targetsError.message}`);
  if (mapRes.error) throw new Error(`psa_spec_card_map(select): ${mapRes.error.message}`);
  const mapRows = (mapRes.data ?? []) as ReportMapRow[];

  const matchedRows = mapRows.filter((row) => row.mapping_status === "MATCHED");
  const unmatchedRows = mapRows.filter((row) => row.mapping_status === "UNMATCHED");

  const unmatchedByReason: Record<string, number> = {};
  for (const row of unmatchedRows) {
    const reason = row.match_reason ?? "UNKNOWN";
    unmatchedByReason[reason] = (unmatchedByReason[reason] ?? 0) + 1;
  }
  const confidenceDistribution: Record<string, number> = {};
  for (const row of matchedRows) {
    const bucket = confidenceBucket(row.match_confidence);
    confidenceDistribution[bucket] = (confidenceDistribution[bucket] ?? 0) + 1;
  }

  const sampled = [
    ...sampleRows(matchedRows, REPORT_SAMPLE_SIZE),
    ...sampleRows(unmatchedRows, REPORT_SAMPLE_SIZE),
  ];
  const descriptions = new Map<number, string | null>();
  if (sampled.length > 0) {
    const { data, error } = await supabase
      .from("psa_spec_targets")
      .select("spec_id, description")
      .in("spec_id", sampled.map((row) => row.spec_id));
    if (error) throw new Error(`psa_spec_targets(descriptions): ${error.message}`);
    for (const row of (data ?? []) as Array<{ spec_id: number; description: string | null }>) {
      descriptions.set(row.spec_id, row.description);
    }
  }

  const total = targetsTotal ?? 0;
  const decided = mapRows.length;
  const matchRatePct = decided > 0
    ? Number(((matchedRows.length / decided) * 100).toFixed(2))
    : 0;
  // The handoff's definition-of-done denominator: every target either
  // confidently matched or explicitly queued — nothing silently skipped.
  const coveragePct = total > 0
    ? Number(((decided / total) * 100).toFixed(2))
    : 0;

  return {
    targetsTotal: total,
    decided,
    coveragePct,
    matched: matchedRows.length,
    unmatched: unmatchedRows.length,
    matchRatePct,
    verified: mapRows.filter((row) => row.verified).length,
    printingResolved: matchedRows.filter((row) => row.printing_id !== null).length,
    confidenceDistribution,
    unmatchedByReason,
    samples: sampled.map((row) => ({
      specId: row.spec_id,
      description: descriptions.get(row.spec_id) ?? null,
      mappingStatus: row.mapping_status,
      canonicalSlug: row.canonical_slug,
      matchType: row.match_type,
      matchConfidence: row.match_confidence,
      matchReason: row.match_reason,
      verified: row.verified,
    })),
  };
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const params = new URL(req.url).searchParams;

  try {
    if (params.get("mode") === "report") {
      const report = await buildReport();
      return NextResponse.json({ ok: true, mode: "report", ...report });
    }

    const specIdParam = Number.parseInt(params.get("specId") ?? "", 10);
    const limitParam = Number.parseInt(params.get("limit") ?? "", 10);

    const result = await runPsaSpecMatch({
      specId: Number.isInteger(specIdParam) && specIdParam > 0 ? specIdParam : null,
      limit: Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined,
      force: params.get("force") === "1",
      dryRun: params.get("dryRun") === "1",
    });

    if (!result.ok) {
      console.error("[match-psa-specs] run failed", { error: result.firstError });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[match-psa-specs] run failed", { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
