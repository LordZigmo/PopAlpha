import {
  loadPairingCatalogInputs,
  normalizePairingName,
} from "./pairing-catalog.mjs";

/**
 * EN <-> JP card-pairing logic.
 *
 * Shared by:
 *   - scripts/backfill-card-translations.mjs (manual bulk runs)
 *   - app/api/cron/refresh-card-translations/route.ts (weekly cron)
 *
 * Algorithm: rule-based set-pair join, no embeddings.
 *
 * Scrydex assigns set IDs per-language (EN `base1` = Base Set,
 * JP `base1_ja` = Expansion Pack). The `public.set_pair_map` table
 * records verified EN-set -> JP-set equivalence. Within a verified
 * set pair, we pair an EN card to the JP card whose canonical_name
 * matches case-insensitively. Exactly one JP match -> pair; zero or
 * multiple -> leave unpaired.
 */

export const PAIRING_SOURCE = "set_pair";
export const PAIRING_CONFIDENCE = 1.0;
export const PAIRING_RANK = 0;

function sortedArray(value) {
  return [...value].sort((a, b) => String(a).localeCompare(String(b)));
}

export function buildTranslationMatchCatalog({
  canonicalCards,
  cardPrintings,
  setPairs,
}) {
  const cardsBySlug = new Map();
  for (const card of canonicalCards) {
    cardsBySlug.set(card.slug, {
      slug: card.slug,
      language: card.language,
      canonical_name: card.canonical_name,
      nameKey: normalizePairingName(card.canonical_name),
    });
  }

  const setCodesBySlug = new Map();
  const jpSlugsBySetCode = new Map();
  for (const printing of cardPrintings) {
    if (!printing.set_code) continue;
    const card = cardsBySlug.get(printing.canonical_slug);
    if (!card) continue;

    let setCodes = setCodesBySlug.get(printing.canonical_slug);
    if (!setCodes) {
      setCodes = new Set();
      setCodesBySlug.set(printing.canonical_slug, setCodes);
    }
    setCodes.add(printing.set_code);

    if (card.language === "JP") {
      let jpSlugs = jpSlugsBySetCode.get(printing.set_code);
      if (!jpSlugs) {
        jpSlugs = new Set();
        jpSlugsBySetCode.set(printing.set_code, jpSlugs);
      }
      jpSlugs.add(card.slug);
    }
  }

  const verifiedSetPairByEnCode = new Map();
  for (const pair of setPairs) {
    if (pair.verified !== true) continue;
    verifiedSetPairByEnCode.set(pair.en_set_code, pair);
  }

  return {
    cardsBySlug,
    setCodesBySlug,
    jpSlugsBySetCode,
    verifiedSetPairByEnCode,
  };
}

export async function loadTranslationMatchCatalog(supabase, { setPairs = null } = {}) {
  const inputs = await loadPairingCatalogInputs(supabase, { setPairs });
  return buildTranslationMatchCatalog(inputs);
}

/**
 * Find the JP pair for a given EN canonical_slug using a preloaded
 * catalog snapshot. Returns one of:
 *
 *   { kind: "paired", jp_slug, en_set_code, jp_set_code, en_set_name, jp_set_name }
 *   { kind: "unpaired", reason: "no_verified_set_pair", en_set_code }
 *   { kind: "unpaired", reason: "no_name_match", en_set_code, jp_set_code }
 *   { kind: "ambiguous", reason: "multiple_en_set_codes", en_set_codes }
 *   { kind: "ambiguous", reason: "multiple_jp_matches", jp_slugs, en_set_code, jp_set_code }
 */
export function findPairBySetCodeInCatalog(catalog, enSlug) {
  const enCard = catalog.cardsBySlug.get(enSlug);
  if (!enCard || enCard.language !== "EN") {
    return { kind: "unpaired", reason: "no_verified_set_pair", en_set_code: null };
  }

  const setCodes = sortedArray(catalog.setCodesBySlug.get(enSlug) ?? new Set());
  if (setCodes.length > 1) {
    return { kind: "ambiguous", reason: "multiple_en_set_codes", en_set_codes: setCodes };
  }
  if (setCodes.length === 0) {
    return { kind: "unpaired", reason: "no_verified_set_pair", en_set_code: null };
  }

  const enSetCode = setCodes[0];
  const pair = catalog.verifiedSetPairByEnCode.get(enSetCode);
  if (!pair) {
    return { kind: "unpaired", reason: "no_verified_set_pair", en_set_code: enSetCode };
  }

  const jpSlugs = [];
  for (const jpSlug of catalog.jpSlugsBySetCode.get(pair.jp_set_code) ?? []) {
    const jpCard = catalog.cardsBySlug.get(jpSlug);
    if (jpCard?.language === "JP" && jpCard.nameKey === enCard.nameKey) {
      jpSlugs.push(jpSlug);
    }
  }
  jpSlugs.sort((a, b) => a.localeCompare(b));

  if (jpSlugs.length === 0) {
    return {
      kind: "unpaired",
      reason: "no_name_match",
      en_set_code: enSetCode,
      jp_set_code: pair.jp_set_code,
    };
  }
  if (jpSlugs.length > 1) {
    return {
      kind: "ambiguous",
      reason: "multiple_jp_matches",
      jp_slugs: jpSlugs,
      en_set_code: enSetCode,
      jp_set_code: pair.jp_set_code,
    };
  }

  return {
    kind: "paired",
    jp_slug: jpSlugs[0],
    en_set_code: enSetCode,
    jp_set_code: pair.jp_set_code,
    en_set_name: pair.en_set_name ?? null,
    jp_set_name: pair.jp_set_name ?? null,
  };
}

export async function deletePairingsForEnSlug(supabase, enSlug) {
  // Only remove rows the rule matcher itself produced (source='set_pair').
  // Manually-curated pairings (source='manual') are preserved: the rule pairs
  // by name within a set pair, so multi-version chase cards (e.g. the Mega-ex
  // SAR ladders — Mega Dragonite ex etc.) are "ambiguous" and can only be paired
  // by hand (rarity-tier matched). Without this filter the weekly refresh cron
  // would delete those hand-curated rows on every pass.
  const { count, error } = await supabase
    .from("card_translations")
    .delete({ count: "exact" })
    .eq("en_slug", enSlug)
    .eq("source", PAIRING_SOURCE);
  if (error) throw new Error(`card_translations delete: ${error.message}`);
  return count ?? 0;
}

export async function upsertPrimaryPairing(supabase, enSlug, jpSlug) {
  const stale = await supabase
    .from("card_translations")
    .delete({ count: "exact" })
    .eq("en_slug", enSlug)
    .neq("jp_slug", jpSlug)
    .eq("source", PAIRING_SOURCE); // never clobber a manual override
  if (stale.error) throw new Error(`card_translations stale delete: ${stale.error.message}`);

  const { data, error } = await supabase
    .from("card_translations")
    .upsert(
      {
        en_slug: enSlug,
        jp_slug: jpSlug,
        confidence: PAIRING_CONFIDENCE,
        rank: PAIRING_RANK,
        source: PAIRING_SOURCE,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "en_slug,jp_slug" },
    )
    .select("en_slug");
  if (error) throw new Error(`card_translations upsert: ${error.message}`);
  return data?.length ?? 0;
}
