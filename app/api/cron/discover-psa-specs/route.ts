/**
 * Cron: discover-psa-specs (Population Tables Phase 2b)
 *
 * Walks the psa_pop_set_pages registry and ingests PSA pop-report set
 * pages: every spec in the set lands in psa_spec_targets
 * (source='pop_scrape', structured fields + page provenance), the row's
 * grade distribution is captured as a same-day psa_spec_pop_snapshots
 * row (source='pop_scrape'), and the spec matcher runs over the new
 * arrivals. Zero official-API quota — this is the whole-catalog
 * discovery channel.
 *
 * DELIBERATELY NOT SCHEDULED in vercel.json yet: PSA fronts
 * www.psacard.com with Cloudflare and datacenter egress is unverified.
 * Verify mechanics first via scripts/discover-psa-specs.mjs from a
 * residential connection, then probe this route manually
 * (?headingId=&dryRun=1) from production; add the schedule only once
 * both pass. A schedule on an endpoint that 403s would page through
 * Vercel cron alerting daily.
 *
 * Manual params:
 *   ?headingId=189863   one registered page (errors if unregistered)
 *   ?limit=3            pages per run from the rotation (default 3)
 *   ?dryRun=1           fetch + parse only, no writes
 *   ?noSnapshot=1       targets only, skip pop capture
 *   ?noMatch=1          skip the post-discovery match kick
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runPsaSpecDiscovery } from "@/lib/backfill/psa-spec-discovery";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const params = new URL(req.url).searchParams;
  const headingIdParam = Number.parseInt(params.get("headingId") ?? "", 10);
  const limitParam = Number.parseInt(params.get("limit") ?? "", 10);

  try {
    const result = await runPsaSpecDiscovery({
      headingId: Number.isInteger(headingIdParam) && headingIdParam > 0 ? headingIdParam : null,
      pageLimit: Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined,
      dryRun: params.get("dryRun") === "1",
      snapshot: params.get("noSnapshot") !== "1",
      match: params.get("noMatch") !== "1",
    });

    if (!result.ok) {
      console.error("[discover-psa-specs] run failed", {
        firstError: result.firstError,
        pagesAttempted: result.pagesAttempted,
        pagesSucceeded: result.pagesSucceeded,
      });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[discover-psa-specs] run failed", { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
