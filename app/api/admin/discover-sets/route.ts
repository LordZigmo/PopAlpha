/**
 * Admin: discover-sets (on-demand)
 *
 * Curl-able trigger for the same new-set discovery pass that runs weekly.
 * Forces a full fetch (no totalCount probe) so callers can use it to seed
 * a set the moment they know Scrydex has published it.
 *
 *   curl -X POST \
 *     -H "Authorization: Bearer $ADMIN_SECRET" \
 *     https://popalpha.ai/api/admin/discover-sets
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import { runDiscoverNewSets } from "@/lib/admin/discover-new-sets";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const result = await runDiscoverNewSets({ force: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
