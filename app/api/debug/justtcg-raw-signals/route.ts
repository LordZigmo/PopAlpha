import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import type { JustTcgCard } from "@/lib/providers/justtcg";

export const runtime = "nodejs";
export const maxDuration = 300;

const PROVIDER = "JUSTTCG";
const ENDPOINT = "/cards";

type RawPayloadRow = {
  id: string;
  fetched_at: string;
  params: Record<string, unknown> | null;
  response: {
    data?: JustTcgCard[];
  } | null;
};

type MatchSample = {
  rawPayloadId: string;
  fetchedAt: string;
  providerSetId: string | null;
  cardId: string;
  cardName: string;
  field: string;
  matchedText: string;
};

function parseOptionalInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function providerSetIdFromParams(params: Record<string, unknown> | null | undefined): string | null {
  const value = typeof params?.set === "string" ? params.set.trim() : "";
  return value || null;
}

function findTerm(source: string | null | undefined, patterns: RegExp[]): string | null {
  const value = String(source ?? "");
  if (!value) return null;
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const payloadLimit = parseOptionalInt(url.searchParams.get("payloads"), 10, 25);
  const sampleLimit = parseOptionalInt(url.searchParams.get("samples"), 20, 50);

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_raw_payloads")
    .select("id, fetched_at, params, response")
    .eq("provider", PROVIDER)
    .eq("endpoint", ENDPOINT)
    .gte("status_code", 200)
    .lt("status_code", 300)
    .order("fetched_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(payloadLimit);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as RawPayloadRow[];
  const firstEditionPatterns = [/\b1st edition\b/i, /\bfirst edition\b/i, /\b1st[-\s]?ed(?:ition)?\b/i];
  const pokemonCenterPatterns = [/\bpokemon center\b/i, /\bpokemoncenter\b/i];

  let cardsScanned = 0;
  let variantsScanned = 0;
  let firstEditionHits = 0;
  let pokemonCenterHits = 0;
  const firstEditionSamples: MatchSample[] = [];
  const pokemonCenterSamples: MatchSample[] = [];

  for (const row of rows) {
    const providerSetId = providerSetIdFromParams(row.params);
    const cards = Array.isArray(row.response?.data) ? row.response?.data ?? [] : [];

    for (const card of cards) {
      cardsScanned += 1;
      const detailsText = card.details == null
        ? ""
        : typeof card.details === "string"
          ? card.details
          : JSON.stringify(card.details);

      const candidateFields: Array<{ field: string; value: string | null | undefined }> = [
        { field: "card.name", value: card.name },
        { field: "card.id", value: card.id },
        { field: "card.set_name", value: card.set_name },
        { field: "card.details", value: detailsText },
      ];

      for (const candidate of candidateFields) {
        const firstEditionMatch = findTerm(candidate.value, firstEditionPatterns);
        if (firstEditionMatch) {
          firstEditionHits += 1;
          if (firstEditionSamples.length < sampleLimit) {
            firstEditionSamples.push({
              rawPayloadId: row.id,
              fetchedAt: row.fetched_at,
              providerSetId,
              cardId: card.id,
              cardName: card.name,
              field: candidate.field,
              matchedText: firstEditionMatch,
            });
          }
        }

        const pokemonCenterMatch = findTerm(candidate.value, pokemonCenterPatterns);
        if (pokemonCenterMatch) {
          pokemonCenterHits += 1;
          if (pokemonCenterSamples.length < sampleLimit) {
            pokemonCenterSamples.push({
              rawPayloadId: row.id,
              fetchedAt: row.fetched_at,
              providerSetId,
              cardId: card.id,
              cardName: card.name,
              field: candidate.field,
              matchedText: pokemonCenterMatch,
            });
          }
        }
      }

      for (const variant of card.variants ?? []) {
        variantsScanned += 1;
        const variantFields: Array<{ field: string; value: string | null | undefined }> = [
          { field: "variant.printing", value: variant.printing },
          { field: "variant.condition", value: variant.condition },
          { field: "variant.language", value: variant.language },
          { field: "variant.id", value: variant.id },
        ];

        for (const candidate of variantFields) {
          const firstEditionMatch = findTerm(candidate.value, firstEditionPatterns);
          if (firstEditionMatch) {
            firstEditionHits += 1;
            if (firstEditionSamples.length < sampleLimit) {
              firstEditionSamples.push({
                rawPayloadId: row.id,
                fetchedAt: row.fetched_at,
                providerSetId,
                cardId: card.id,
                cardName: card.name,
                field: candidate.field,
                matchedText: firstEditionMatch,
              });
            }
          }

          const pokemonCenterMatch = findTerm(candidate.value, pokemonCenterPatterns);
          if (pokemonCenterMatch) {
            pokemonCenterHits += 1;
            if (pokemonCenterSamples.length < sampleLimit) {
              pokemonCenterSamples.push({
                rawPayloadId: row.id,
                fetchedAt: row.fetched_at,
                providerSetId,
                cardId: card.id,
                cardName: card.name,
                field: candidate.field,
                matchedText: pokemonCenterMatch,
              });
            }
          }
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    payloadsScanned: rows.length,
    cardsScanned,
    variantsScanned,
    firstEdition: {
      hits: firstEditionHits,
      samples: firstEditionSamples,
    },
    pokemonCenter: {
      hits: pokemonCenterHits,
      samples: pokemonCenterSamples,
    },
  });
}
