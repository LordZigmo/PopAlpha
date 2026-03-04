import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type SetMapRow = {
  canonical_set_code: string;
};

type MatchRow = {
  provider_normalized_observation_id: string;
};

type ObservationRow = {
  id: string;
  provider_card_id: string;
  provider_variant_id: string;
  card_name: string;
  normalized_card_number: string | null;
  normalized_finish: string;
  normalized_edition: string;
  normalized_stamp: string;
  normalized_language: string;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  set_name: string | null;
  set_code: string | null;
  year: number | null;
  card_number: string;
  language: string;
  finish: string;
  finish_detail: string | null;
  edition: string;
  stamp: string | null;
  rarity: string | null;
  image_url: string | null;
  source: string;
  source_id: string | null;
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

function stampValueFromNormalized(normalizedStamp: string): string | null {
  if (normalizedStamp === "NONE") return null;
  if (normalizedStamp === "POKEMON_CENTER") return "POKEMON_CENTER";
  return normalizedStamp;
}

function derivedSourceId(base: PrintingRow): string {
  const seed = base.source_id?.trim() || base.id;
  return `${seed}::FIRST_EDITION_DERIVED`;
}

export async function POST(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const providerSetId = url.searchParams.get("set")?.trim() || "";
  if (!providerSetId) {
    return NextResponse.json({ ok: false, error: "Missing required ?set=providerSetId" }, { status: 400 });
  }

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

  const { data: unmatchedRows, error: unmatchedError } = await supabase
    .from("provider_observation_matches")
    .select("provider_normalized_observation_id")
    .eq("provider", "JUSTTCG")
    .eq("provider_set_id", providerSetId)
    .eq("asset_type", "single")
    .eq("match_status", "UNMATCHED")
    .eq("match_reason", "NO_STRICT_PRINTING_MATCH");

  if (unmatchedError) {
    return NextResponse.json({ ok: false, error: unmatchedError.message }, { status: 500 });
  }

  const observationIds = (unmatchedRows ?? []).map((row) => (row as MatchRow).provider_normalized_observation_id);
  if (observationIds.length === 0) {
    return NextResponse.json({
      ok: true,
      providerSetId,
      canonicalSetCode,
      observationsConsidered: 0,
      inserted: 0,
      skippedExisting: 0,
      skippedAmbiguous: 0,
      skippedNoBase: 0,
      samples: [],
    });
  }

  const { data: observations, error: observationError } = await supabase
    .from("provider_normalized_observations")
    .select("id, provider_card_id, provider_variant_id, card_name, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_language")
    .in("id", observationIds)
    .eq("normalized_edition", "FIRST_EDITION");

  if (observationError) {
    return NextResponse.json({ ok: false, error: observationError.message }, { status: 500 });
  }

  const { data: printingRows, error: printingsError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, set_code, year, card_number, language, finish, finish_detail, edition, stamp, rarity, image_url, source, source_id")
    .eq("set_code", canonicalSetCode);

  if (printingsError) {
    return NextResponse.json({ ok: false, error: printingsError.message }, { status: 500 });
  }

  const allPrintings = (printingRows ?? []) as PrintingRow[];
  const derivedRows: Array<Record<string, unknown>> = [];
  const seenTargetKeys = new Set<string>();
  let skippedExisting = 0;
  let skippedAmbiguous = 0;
  let skippedNoBase = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const observation of (observations ?? []) as ObservationRow[]) {
    const cardNumber = String(observation.normalized_card_number ?? "").trim();
    if (!cardNumber) {
      skippedNoBase += 1;
      continue;
    }

    const language = normalizeLanguageToCanonical(observation.normalized_language);
    const stampValue = stampValueFromNormalized(observation.normalized_stamp);
    const existingFirstEdition = allPrintings.find((row) =>
      row.card_number === cardNumber
      && row.language === language
      && row.finish === observation.normalized_finish
      && row.edition === "FIRST_EDITION"
      && normalizeStampToken(row.stamp) === observation.normalized_stamp
    );

    if (existingFirstEdition) {
      skippedExisting += 1;
      continue;
    }

    const baseCandidates = allPrintings.filter((row) =>
      row.card_number === cardNumber
      && row.language === language
      && row.finish === observation.normalized_finish
      && row.edition === "UNLIMITED"
      && normalizeStampToken(row.stamp) === observation.normalized_stamp
    );

    if (baseCandidates.length === 0) {
      skippedNoBase += 1;
      continue;
    }

    if (baseCandidates.length > 1) {
      skippedAmbiguous += 1;
      continue;
    }

    const base = baseCandidates[0];
    const targetKey = [
      canonicalSetCode,
      cardNumber,
      language,
      observation.normalized_finish,
      "FIRST_EDITION",
      observation.normalized_stamp,
      String(base.finish_detail ?? ""),
    ].join("::");

    if (seenTargetKeys.has(targetKey)) continue;
    seenTargetKeys.add(targetKey);

    const row = {
      canonical_slug: base.canonical_slug,
      set_name: base.set_name,
      set_code: base.set_code,
      year: base.year,
      card_number: base.card_number,
      language: base.language,
      finish: base.finish,
      finish_detail: base.finish_detail,
      edition: "FIRST_EDITION",
      stamp: stampValue,
      rarity: base.rarity,
      image_url: base.image_url,
      source: base.source,
      source_id: derivedSourceId(base),
    };

    derivedRows.push(row);
    if (samples.length < 25) {
      samples.push({
        observationId: observation.id,
        providerCardId: observation.provider_card_id,
        providerVariantId: observation.provider_variant_id,
        cardName: observation.card_name,
        clonedFromPrintingId: base.id,
        canonicalSlug: base.canonical_slug,
        cardNumber: base.card_number,
        finish: base.finish,
        edition: "FIRST_EDITION",
      });
    }
  }

  let inserted = 0;
  if (derivedRows.length > 0) {
    for (const row of derivedRows) {
      const { error: insertError } = await supabase
        .from("card_printings")
        .insert(row);

      if (insertError) {
        if (insertError.code === "23505") {
          skippedExisting += 1;
          continue;
        }
        return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
      }
      inserted += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    providerSetId,
    canonicalSetCode,
    observationsConsidered: (observations ?? []).length,
    inserted,
    skippedExisting,
    skippedAmbiguous,
    skippedNoBase,
    samples,
  });
}
