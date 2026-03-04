import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const SELECT_COLUMNS = [
  "provider_raw_payload_id",
  "provider_set_id",
  "provider_card_id",
  "provider_variant_id",
  "asset_type",
  "card_name",
  "card_number",
  "normalized_card_number",
  "provider_finish",
  "normalized_finish",
  "normalized_edition",
  "normalized_stamp",
  "provider_condition",
  "normalized_condition",
  "provider_language",
  "normalized_language",
  "observed_price",
  "observed_at",
  "variant_ref",
  "history_points_30d_count",
].join(", ");

async function loadOne(params: {
  column: "normalized_edition" | "normalized_stamp";
  value: string;
  assetType?: "single" | "sealed";
}) {
  const supabase = dbAdmin();
  let query = supabase
    .from("provider_normalized_observations")
    .select(SELECT_COLUMNS)
    .eq(params.column, params.value)
    .order("observed_at", { ascending: false })
    .order("provider_raw_payload_id", { ascending: false })
    .limit(1);

  if (params.assetType) {
    query = query.eq("asset_type", params.assetType);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`${params.column}: ${error.message}`);
  }

  return data ?? null;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const [firstEditionSingleExample, firstEditionSealedExample, pokemonCenterExample] = await Promise.all([
      loadOne({ column: "normalized_edition", value: "FIRST_EDITION", assetType: "single" }),
      loadOne({ column: "normalized_edition", value: "FIRST_EDITION", assetType: "sealed" }),
      loadOne({ column: "normalized_stamp", value: "POKEMON_CENTER" }),
    ]);

    return NextResponse.json({
      ok: true,
      firstEditionSingleExample,
      firstEditionSealedExample,
      pokemonCenterExample,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
