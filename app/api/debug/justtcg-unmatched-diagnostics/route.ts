import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type ObservationRow = {
  id: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  card_name: string;
  normalized_card_number: string | null;
  normalized_finish: string;
  normalized_edition: string;
  normalized_stamp: string;
  normalized_language: string;
  variant_ref: string;
};

type MatchRow = {
  provider_normalized_observation_id: string;
  match_reason: string | null;
};

type SetMapRow = {
  canonical_set_code: string;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string;
  language: string;
  finish: string;
  edition: string;
  stamp: string | null;
  finish_detail: string | null;
};

function normalizeLanguageToCanonical(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "EN";
  if (normalized === "en") return "EN";
  if (normalized === "jp" || normalized === "ja") return "JP";
  if (normalized === "kr") return "KR";
  if (normalized === "fr") return "FR";
  if (normalized === "de") return "DE";
  if (normalized === "es") return "ES";
  if (normalized === "it") return "IT";
  if (normalized === "pt") return "PT";
  return normalized.toUpperCase();
}

function normalizeStampToken(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "NONE";
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "NONE";
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const providerSetId = url.searchParams.get("set")?.trim() || null;
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 25));

  if (!providerSetId) {
    return NextResponse.json({ ok: false, error: "Missing required ?set=providerSetId" }, { status: 400 });
  }

  const supabase = dbAdmin();

  const { data: setMapData, error: setMapError } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code")
    .eq("provider", "JUSTTCG")
    .eq("provider_set_id", providerSetId)
    .maybeSingle<SetMapRow>();

  if (setMapError) {
    return NextResponse.json({ ok: false, error: setMapError.message }, { status: 500 });
  }

  const canonicalSetCode = setMapData?.canonical_set_code ?? null;

  const { data: unmatchedMatches, error: matchError } = await supabase
    .from("provider_observation_matches")
    .select("provider_normalized_observation_id, match_reason")
    .eq("provider", "JUSTTCG")
    .eq("provider_set_id", providerSetId)
    .eq("asset_type", "single")
    .eq("match_status", "UNMATCHED")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (matchError) {
    return NextResponse.json({ ok: false, error: matchError.message }, { status: 500 });
  }

  const observationIds = (unmatchedMatches ?? []).map((row) => (row as MatchRow).provider_normalized_observation_id);
  if (observationIds.length === 0) {
    return NextResponse.json({
      ok: true,
      providerSetId,
      canonicalSetCode,
      diagnostics: [],
    });
  }

  const { data: observations, error: obsError } = await supabase
    .from("provider_normalized_observations")
    .select("id, provider_set_id, provider_card_id, provider_variant_id, card_name, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language, variant_ref")
    .in("id", observationIds);

  if (obsError) {
    return NextResponse.json({ ok: false, error: obsError.message }, { status: 500 });
  }

  let printings: PrintingRow[] = [];
  if (canonicalSetCode) {
    const { data: printingData, error: printingError } = await supabase
      .from("card_printings")
      .select("id, canonical_slug, card_number, language, finish, edition, stamp, finish_detail")
      .eq("set_code", canonicalSetCode);

    if (printingError) {
      return NextResponse.json({ ok: false, error: printingError.message }, { status: 500 });
    }
    printings = (printingData ?? []) as PrintingRow[];
  }

  const matchReasonByObservationId = new Map<string, string | null>();
  for (const row of (unmatchedMatches ?? []) as MatchRow[]) {
    matchReasonByObservationId.set(row.provider_normalized_observation_id, row.match_reason);
  }

  const diagnostics = ((observations ?? []) as ObservationRow[]).map((observation) => {
    const cardNumber = String(observation.normalized_card_number ?? "").trim();
    const language = normalizeLanguageToCanonical(observation.normalized_language);
    const rowsForNumber = printings.filter((row) =>
      row.card_number === cardNumber
      && row.language === language
    );
    const exactShapeRows = rowsForNumber.filter((row) =>
      row.finish === observation.normalized_finish
      && row.edition === observation.normalized_edition
      && normalizeStampToken(row.stamp) === observation.normalized_stamp
    );
    const finishEditionRows = rowsForNumber.filter((row) =>
      row.finish === observation.normalized_finish
      && row.edition === observation.normalized_edition
    );
    const editionOnlyRows = rowsForNumber.filter((row) => row.edition === observation.normalized_edition);
    const finishOnlyRows = rowsForNumber.filter((row) => row.finish === observation.normalized_finish);

    return {
      observationId: observation.id,
      providerCardId: observation.provider_card_id,
      providerVariantId: observation.provider_variant_id,
      cardName: observation.card_name,
      normalizedCardNumber: observation.normalized_card_number,
      normalizedFinish: observation.normalized_finish,
      normalizedEdition: observation.normalized_edition,
      normalizedStamp: observation.normalized_stamp,
      normalizedLanguage: observation.normalized_language,
      variantRef: observation.variant_ref,
      matchReason: matchReasonByObservationId.get(observation.id) ?? null,
      localCandidateCounts: {
        sameNumberLanguage: rowsForNumber.length,
        sameFinishEdition: finishEditionRows.length,
        sameEditionOnly: editionOnlyRows.length,
        sameFinishOnly: finishOnlyRows.length,
        exactShape: exactShapeRows.length,
      },
      localSamples: rowsForNumber.slice(0, 5).map((row) => ({
        printingId: row.id,
        canonicalSlug: row.canonical_slug,
        finish: row.finish,
        edition: row.edition,
        stamp: row.stamp,
        finishDetail: row.finish_detail,
      })),
    };
  });

  return NextResponse.json({
    ok: true,
    provider: "JUSTTCG",
    providerSetId,
    canonicalSetCode,
    diagnostics,
  });
}
