import type { HomepageCard } from "@/lib/data/homepage";
import { getCanonicalMarketPulseMap, type CanonicalMarketPulse } from "@/lib/data/market";
import { dbPublic } from "@/lib/db";

type CanonicalCardLookupRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  subject: string | null;
  primary_image_url: string | null;
};

function fallbackSubjectFromName(name: string): string | null {
  const withoutParens = name.split("(")[0]?.trim() ?? "";
  const stripped = withoutParens.replace(
    /\s+(ex|gx|vmax|vstar|v-union|v-union set|v|lv\.x|star|prime|break|radiant)\b.*$/i,
    "",
  ).trim();
  return stripped || null;
}

function toHomepageCard(
  row: CanonicalCardLookupRow,
  market: CanonicalMarketPulse | null | undefined,
): HomepageCard {
  return {
    slug: row.slug,
    name: row.canonical_name,
    set_name: row.set_name,
    year: row.year,
    market_price: market?.marketPrice ?? null,
    change_pct: market?.changePct ?? null,
    change_window: market?.changeWindow ?? null,
    confidence_score: market?.confidenceScore ?? null,
    low_confidence: market?.lowConfidence ?? null,
    mover_tier: null,
    image_url: row.primary_image_url ?? null,
    sparkline_7d: [],
  };
}

function sortCards(cards: HomepageCard[]): HomepageCard[] {
  return [...cards].sort((a, b) => {
    const priceA = a.market_price ?? -1;
    const priceB = b.market_price ?? -1;
    if (priceA !== priceB) return priceB - priceA;
    const changeA = a.change_pct ?? -9999;
    const changeB = b.change_pct ?? -9999;
    if (changeA !== changeB) return changeB - changeA;
    return a.name.localeCompare(b.name);
  });
}

export async function getRelatedCardCarousels(input: {
  slug: string;
  canonicalName: string;
  setName: string | null;
  subject: string | null;
  limit?: number;
}): Promise<{
  fromSet: HomepageCard[];
  fromPokemon: HomepageCard[];
}> {
  const { slug, canonicalName, setName, subject, limit = 5 } = input;
  const db = dbPublic();
  const effectiveSubject = subject?.trim() || fallbackSubjectFromName(canonicalName);

  const [fromSetResult, fromPokemonResult] = await Promise.all([
    setName
      ? db
          .from("canonical_cards")
          .select("slug, canonical_name, set_name, year, subject, primary_image_url")
          .eq("set_name", setName)
          .neq("slug", slug)
          .limit(Math.max(limit * 3, 12))
      : Promise.resolve({ data: [] as CanonicalCardLookupRow[], error: null }),
    effectiveSubject
      ? subject?.trim()
        ? db
            .from("canonical_cards")
            .select("slug, canonical_name, set_name, year, subject, primary_image_url")
            .eq("subject", effectiveSubject)
            .neq("slug", slug)
            .limit(Math.max(limit * 4, 16))
        : db
            .from("canonical_cards")
            .select("slug, canonical_name, set_name, year, subject, primary_image_url")
            .ilike("canonical_name", `${effectiveSubject}%`)
            .neq("slug", slug)
            .limit(Math.max(limit * 4, 16))
      : Promise.resolve({ data: [] as CanonicalCardLookupRow[], error: null }),
  ]);

  const fromSetRows = ((fromSetResult.data ?? []) as CanonicalCardLookupRow[]).filter((row) => row.slug !== slug);
  const fromPokemonRows = ((fromPokemonResult.data ?? []) as CanonicalCardLookupRow[]).filter((row) => row.slug !== slug);

  const allSlugs = [...new Set([
    ...fromSetRows.map((row) => row.slug),
    ...fromPokemonRows.map((row) => row.slug),
  ])];

  if (allSlugs.length === 0) {
    return { fromSet: [], fromPokemon: [] };
  }

  const marketMap = await getCanonicalMarketPulseMap(db, allSlugs);

  const fromSet = sortCards(
    fromSetRows.map((row) => toHomepageCard(row, marketMap.get(row.slug))),
  ).slice(0, limit);

  const fromPokemon = sortCards(
    fromPokemonRows.map((row) => toHomepageCard(row, marketMap.get(row.slug))),
  ).slice(0, limit);

  return { fromSet, fromPokemon };
}
