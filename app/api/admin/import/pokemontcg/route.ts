import { NextResponse } from "next/server";
import {
  parsePokemonTcgCanonicalImportBody,
  runScrydexCanonicalImport,
  type PokemonTcgCanonicalImportBody,
} from "@/lib/admin/scrydex-canonical-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const importToken = process.env.ADMIN_IMPORT_TOKEN?.trim();
  if (!importToken) {
    return NextResponse.json({ ok: false, error: "ADMIN_IMPORT_TOKEN not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${importToken}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: PokemonTcgCanonicalImportBody = {};
  try {
    body = (await req.json()) as PokemonTcgCanonicalImportBody;
  } catch {
    body = {};
  }

  const result = await runScrydexCanonicalImport(parsePokemonTcgCanonicalImportBody(body));
  return NextResponse.json(result.body, { status: result.status });
}
