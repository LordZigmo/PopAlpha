import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import {
  parseLegacyPokemonTcgCanonicalRequest,
  runScrydexCanonicalImport,
} from "@/lib/admin/scrydex-canonical-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compatibility shim: routes legacy PokemonTCG canonical import requests
 * into the Scrydex canonical importer.
 *
 * Query translation:
 * - setId      -> expansionId
 * - pageStart  -> pageStart
 * - maxPages   -> maxPages
 * - pageSize   -> pageSize (Scrydex max is 100; downstream route enforces bounds)
 * - dryRun     -> dryRun
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const result = await runScrydexCanonicalImport(parseLegacyPokemonTcgCanonicalRequest(req));
  return NextResponse.json(result.body, { status: result.status });
}
