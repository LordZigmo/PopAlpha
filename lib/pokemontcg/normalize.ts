import type { PokemonTcgCard } from "@/lib/pokemontcg/client";

export type LabelRule = {
  match_type: "variant_key" | "rarity" | "subtype" | "name_regex" | "set_regex";
  match_value: string;
  normalized_finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  normalized_edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN" | null;
  priority: number;
};

export type NormalizedCardRow = {
  id: string;
  name: string;
  set: string;
  year: number;
  number: string;
  slug: string;
  image_url: string | null;
  rarity: string | null;
  supertype: string | null;
  subtypes: string[] | null;
  types: string[] | null;
  source_payload: Record<string, unknown>;
};

export type NormalizedVariantRow = {
  card_id: string;
  variant_key: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
  image_url: string | null;
  source: "pokemontcg";
  source_payload: Record<string, unknown>;
};

export type NormalizedMappingRow = {
  card_id: string;
  source: "pokemontcg";
  mapping_type: "card";
  external_id: string;
  meta: Record<string, unknown>;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("%")) return pattern.toLowerCase() === value.toLowerCase();
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

function deriveVariantWithFallback(
  variantKey: string
): Pick<NormalizedVariantRow, "finish" | "finish_detail" | "edition"> {
  const lower = variantKey.toLowerCase();
  if (lower === "normal") return { finish: "NON_HOLO", finish_detail: null, edition: "UNLIMITED" };
  if (lower === "holofoil") return { finish: "HOLO", finish_detail: null, edition: "UNLIMITED" };
  if (lower === "reverseholofoil") return { finish: "REVERSE_HOLO", finish_detail: null, edition: "UNLIMITED" };
  if (lower.includes("1stedition")) return { finish: "HOLO", finish_detail: variantKey, edition: "FIRST_EDITION" };
  return { finish: "ALT_HOLO", finish_detail: variantKey, edition: "UNKNOWN" };
}

function applyRules(
  card: PokemonTcgCard,
  variantKey: string,
  rules: LabelRule[]
): Pick<NormalizedVariantRow, "finish" | "finish_detail" | "edition"> {
  for (const rule of rules) {
    let matches = false;
    switch (rule.match_type) {
      case "variant_key":
        matches = wildcardMatch(rule.match_value, variantKey);
        break;
      case "rarity":
        matches = wildcardMatch(rule.match_value, card.rarity ?? "");
        break;
      case "subtype":
        matches = (card.subtypes ?? []).some((subtype) => wildcardMatch(rule.match_value, subtype));
        break;
      case "name_regex":
        try {
          matches = new RegExp(rule.match_value, "i").test(card.name);
        } catch {
          matches = false;
        }
        break;
      case "set_regex":
        try {
          matches = new RegExp(rule.match_value, "i").test(card.set?.name ?? "");
        } catch {
          matches = false;
        }
        break;
    }
    if (matches) {
      return {
        finish: rule.normalized_finish,
        finish_detail: rule.finish_detail,
        edition: rule.normalized_edition ?? "UNKNOWN",
      };
    }
  }
  return deriveVariantWithFallback(variantKey);
}

export function normalizeCard(
  apiCard: PokemonTcgCard,
  setYearMap: Map<string, number>,
  rules: LabelRule[]
): {
  cardRow: NormalizedCardRow;
  variantRows: NormalizedVariantRow[];
  mappingRow: NormalizedMappingRow;
} {
  const setId = apiCard.set?.id ?? "unknown-set";
  const year = setYearMap.get(setId) ?? 0;
  const slug = slugify(`${apiCard.name}-${setId}-${apiCard.number}`) || slugify(apiCard.id);
  const imageUrl = apiCard.images?.large ?? apiCard.images?.small ?? null;
  const prices = apiCard.tcgplayer?.prices ?? {};
  const variantKeys = Object.keys(prices);
  const resolvedKeys = variantKeys.length > 0 ? variantKeys : ["unknown"];

  const cardRow: NormalizedCardRow = {
    id: apiCard.id,
    name: apiCard.name,
    set: apiCard.set?.name ?? "Unknown Set",
    year,
    number: apiCard.number,
    slug,
    image_url: imageUrl,
    rarity: apiCard.rarity ?? null,
    supertype: apiCard.supertype ?? null,
    subtypes: apiCard.subtypes ?? null,
    types: apiCard.types ?? null,
    source_payload: apiCard as unknown as Record<string, unknown>,
  };

  const variantRows: NormalizedVariantRow[] = resolvedKeys.map((variantKey) => {
    const resolved = applyRules(apiCard, variantKey, rules);
    const variantPayload =
      variantKey === "unknown"
        ? { variant_key: variantKey }
        : { variant_key: variantKey, price_payload: (prices as Record<string, unknown>)[variantKey] };
    return {
      card_id: apiCard.id,
      variant_key: variantKey,
      finish: resolved.finish,
      finish_detail: resolved.finish_detail,
      edition: resolved.edition,
      stamp: null,
      image_url: imageUrl,
      source: "pokemontcg",
      source_payload: variantPayload,
    };
  });

  const mappingRow: NormalizedMappingRow = {
    card_id: apiCard.id,
    source: "pokemontcg",
    mapping_type: "card",
    external_id: apiCard.id,
    meta: {
      set_id: apiCard.set?.id ?? null,
      set_name: apiCard.set?.name ?? null,
      fetched_at: new Date().toISOString(),
    },
  };

  return {
    cardRow,
    variantRows,
    mappingRow,
  };
}

