import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { backfillJustTcgSet } from "@/lib/backfill/justtcg-set";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const setKey = (url.searchParams.get("set") ?? "paldea-evolved").trim();
  const providerSetId = (url.searchParams.get("providerSetId") ?? "").trim();
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
    });

    const status = result.ok ? 200 : 500;
    return NextResponse.json(
      {
        ...result,
        deprecatedQueryAuth: auth.deprecatedQueryAuth,
      },
      { status },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        error: message,
        deprecatedQueryAuth: auth.deprecatedQueryAuth,
      },
      { status: 500 },
    );
  }
}
