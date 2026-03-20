import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import {
  parseScrydexCanonicalImportRequest,
  runScrydexCanonicalImport,
} from "@/lib/admin/scrydex-canonical-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const result = await runScrydexCanonicalImport(parseScrydexCanonicalImportRequest(req));
  return NextResponse.json(result.body, { status: result.status });
}
