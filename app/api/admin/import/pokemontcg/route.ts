import { NextResponse } from "next/server";
import { POST as runCanonicalImport } from "../pokemontcg-canonical/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ImportBody = {
  pageStart?: number;
  pageEnd?: number;
  maxPages?: number;
  pageSize?: number;
  setId?: string;
  dryRun?: boolean;
};

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int > 0 ? int : fallback;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

export async function POST(req: Request) {
  const importToken = process.env.ADMIN_IMPORT_TOKEN?.trim();
  if (importToken) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${importToken}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: ImportBody = {};
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    body = {};
  }

  const pageStart = toPositiveInt(body.pageStart, 1);
  const pageEnd = body.pageEnd ? toPositiveInt(body.pageEnd, pageStart) : null;
  const maxPages = body.maxPages ? toPositiveInt(body.maxPages, 0) : 0;
  const pageSize = body.pageSize ? toPositiveInt(body.pageSize, 250) : null;
  const setId = typeof body.setId === "string" ? body.setId.trim() : "";
  const dryRun = parseBoolean(body.dryRun);

  const forwardedMaxPages =
    maxPages > 0 ? maxPages : pageEnd !== null ? Math.max(1, pageEnd - pageStart + 1) : undefined;

  const proxyUrl = new URL("http://internal/api/admin/import/pokemontcg-canonical");
  proxyUrl.searchParams.set("pageStart", String(pageStart));
  if (forwardedMaxPages) {
    proxyUrl.searchParams.set("maxPages", String(forwardedMaxPages));
  }
  if (pageSize) {
    proxyUrl.searchParams.set("pageSize", String(pageSize));
  }
  if (setId) {
    proxyUrl.searchParams.set("setId", setId);
  }
  if (dryRun) {
    proxyUrl.searchParams.set("dryRun", "true");
  }

  const headers = new Headers();
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (adminSecret) {
    headers.set("x-admin-secret", adminSecret);
  }

  const proxyRequest = new Request(proxyUrl.toString(), {
    method: "POST",
    headers,
  });

  const response = await runCanonicalImport(proxyRequest);
  const payload = (await response.json()) as Record<string, unknown>;

  return NextResponse.json(payload, { status: response.status });
}
