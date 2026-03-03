import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { backfillJustTcgSet } from "@/lib/backfill/justtcg-set";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const setKey = (url.searchParams.get("set") ?? "paldea-evolved").trim();
  const providerSetId = (url.searchParams.get("providerSetId") ?? "").trim();
  const canonicalSetName = (url.searchParams.get("canonicalSetName") ?? "").trim();
  const language = (url.searchParams.get("language") ?? "EN").trim().toUpperCase();
  const aggressive = url.searchParams.get("aggressive") !== "0";
  const dryRun = url.searchParams.get("dryRun") === "1";

  if (language !== "EN") {
    return NextResponse.json(
      { ok: false, error: "This backfill currently supports EN only." },
      { status: 400 },
    );
  }

  try {
    const result = await backfillJustTcgSet(setKey, {
      language: "EN",
      aggressive,
      dryRun,
      providerSetIdOverride: providerSetId || undefined,
      canonicalSetNameOverride: canonicalSetName || undefined,
    });

    const status = result.ok ? 200 : 500;
    return NextResponse.json(
      {
        ...result,
      },
      { status },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 },
    );
  }
}
