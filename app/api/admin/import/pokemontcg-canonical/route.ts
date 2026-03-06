import { POST as runScrydexCanonicalImport } from "../scrydex-canonical/route";

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
  const url = new URL(req.url);
  const proxyUrl = new URL("http://internal/api/admin/import/scrydex-canonical");

  const pageStart = url.searchParams.get("pageStart");
  const maxPages = url.searchParams.get("maxPages");
  const pageSize = url.searchParams.get("pageSize");
  const setId = url.searchParams.get("setId");
  const dryRun = url.searchParams.get("dryRun");

  if (pageStart) proxyUrl.searchParams.set("pageStart", pageStart);
  if (maxPages) proxyUrl.searchParams.set("maxPages", maxPages);
  if (pageSize) proxyUrl.searchParams.set("pageSize", pageSize);
  if (setId) proxyUrl.searchParams.set("expansionId", setId);
  if (dryRun) proxyUrl.searchParams.set("dryRun", dryRun);

  const forwardedRequest = new Request(proxyUrl.toString(), {
    method: "POST",
    headers: req.headers,
  });

  return runScrydexCanonicalImport(forwardedRequest);
}
