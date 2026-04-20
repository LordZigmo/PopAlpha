/**
 * Cron: discover-new-sets
 *
 * Weekly probe for brand-new Pokemon sets in the Scrydex catalog. Cheap:
 * 1 Scrydex credit per run when no new set exists (the vast majority of
 * weeks). Only spends additional credits on actual new-set releases.
 *
 * See lib/admin/discover-new-sets.ts for the underlying logic.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { runDiscoverNewSets } from "@/lib/admin/discover-new-sets";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const result = await runDiscoverNewSets({ force: false });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
