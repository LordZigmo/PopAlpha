import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type SetMapRow = {
  canonical_set_code: string;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

export async function POST(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const providerSetId = url.searchParams.get("set")?.trim() || "jungle-pokemon";

  const supabase = dbAdmin();
  const { data: setMapRow, error: setMapError } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code")
    .eq("provider", "JUSTTCG")
    .eq("provider_set_id", providerSetId)
    .maybeSingle<SetMapRow>();

  if (setMapError) {
    return NextResponse.json({ ok: false, error: setMapError.message }, { status: 500 });
  }

  const canonicalSetCode = setMapRow?.canonical_set_code ?? null;
  if (!canonicalSetCode) {
    return NextResponse.json({ ok: false, error: `No provider_set_map entry for ${providerSetId}` }, { status: 400 });
  }

  const { data: rows, error: rowsError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, card_number, finish, edition, stamp")
    .eq("set_code", canonicalSetCode)
    .eq("card_number", "64")
    .eq("finish", "NON_HOLO")
    .eq("stamp", "POKE_BALL_PATTERN");

  if (rowsError) {
    return NextResponse.json({ ok: false, error: rowsError.message }, { status: 500 });
  }

  const targets = (rows ?? []) as PrintingRow[];
  let updated = 0;
  for (const row of targets) {
    const { error } = await supabase
      .from("card_printings")
      .update({ stamp: null })
      .eq("id", row.id);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    updated += 1;
  }

  return NextResponse.json({
    ok: true,
    providerSetId,
    canonicalSetCode,
    updated,
    repaired: targets.map((row) => ({
      printingId: row.id,
      canonicalSlug: row.canonical_slug,
      cardNumber: row.card_number,
      finish: row.finish,
      edition: row.edition,
      previousStamp: row.stamp,
      newStamp: null,
    })),
  });
}
