/**
 * Pokedata classification enrichment.
 *
 * Uses Pokedata as a secondary arbiter for card classification:
 * - Cross-reference card identity (name, set, number, rarity)
 * - Validate/enrich card metadata (variant types, condition grades, finish types)
 * - Provide a second price source for comparison (median between JustTCG + Pokedata)
 */

import type { PokedataCard, PokedataVariant } from "./pokedata";
import { mapPokedataPrinting, normalizeCardNumber, normalizeCondition } from "./pokedata";

// ── Types ────────────────────────────────────────────────────────────────────

export type ClassificationResult = {
  matched: boolean;
  confidence: number;        // 0–1
  pokedataCardId: string | null;
  pokedataName: string | null;
  pokedataNumber: string | null;
  pokedataRarity: string | null;
  finishTypes: string[];     // Our finish enum values found in variants
  conditions: string[];      // Normalized conditions found
  priceComparison: PriceComparison | null;
};

export type PriceComparison = {
  pokedataPrice: number;
  justTcgPrice: number | null;
  medianPrice: number;
  delta: number | null;       // absolute difference
  deltaPercent: number | null; // percentage difference
};

// ── Card matching ────────────────────────────────────────────────────────────

function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score how well a Pokedata card matches a canonical card.
 * Returns 0–100, where 100 = perfect match.
 */
export function scoreCardMatch(
  pokedataCard: PokedataCard,
  canonicalName: string,
  canonicalNumber: string,
): number {
  let score = 0;

  // Number match (most reliable)
  const pdNum = normalizeCardNumber(pokedataCard.number);
  const canNum = normalizeCardNumber(canonicalNumber);
  if (pdNum && canNum && pdNum === canNum) {
    score += 50;
  }

  // Name match
  const pdName = normalizeName(pokedataCard.name);
  const canName = normalizeName(canonicalName);
  if (pdName === canName) {
    score += 40;
  } else if (pdName.includes(canName) || canName.includes(pdName)) {
    score += 25;
  } else {
    // Token overlap
    const pdTokens = new Set(pdName.split(" ").filter(Boolean));
    const canTokens = new Set(canName.split(" ").filter(Boolean));
    const intersection = [...pdTokens].filter((t) => canTokens.has(t)).length;
    const union = new Set([...pdTokens, ...canTokens]).size;
    if (union > 0) {
      score += Math.round((intersection / union) * 20);
    }
  }

  // Rarity bonus (if present, adds confidence)
  if (pokedataCard.rarity) {
    score += 10;
  }

  return Math.min(100, score);
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify a card using Pokedata as a secondary source.
 * Matches a Pokedata card against canonical card data and extracts
 * enrichment information.
 */
export function classifyFromPokedata(
  pokedataCard: PokedataCard,
  canonicalName: string,
  canonicalNumber: string,
  justTcgPrice?: number | null,
): ClassificationResult {
  const confidence = scoreCardMatch(pokedataCard, canonicalName, canonicalNumber) / 100;
  const matched = confidence >= 0.6;

  // Extract finish types from all variants
  const finishTypes = [
    ...new Set(
      (pokedataCard.variants ?? [])
        .map((v) => mapPokedataPrinting(v.printing))
        .filter((f) => f !== "UNKNOWN"),
    ),
  ];

  // Extract normalized conditions
  const conditions = [
    ...new Set(
      (pokedataCard.variants ?? [])
        .map((v) => normalizeCondition(v.condition))
        .filter(Boolean),
    ),
  ];

  // Price comparison: use best NM variant if available
  const nmVariant = findBestNmVariant(pokedataCard.variants ?? []);
  let priceComparison: PriceComparison | null = null;

  if (nmVariant?.price && nmVariant.price > 0) {
    const pokedataPrice = nmVariant.price;
    const medianPrice =
      justTcgPrice && justTcgPrice > 0
        ? (pokedataPrice + justTcgPrice) / 2
        : pokedataPrice;
    const delta = justTcgPrice != null ? Math.abs(pokedataPrice - justTcgPrice) : null;
    const deltaPercent =
      justTcgPrice != null && justTcgPrice > 0
        ? parseFloat((((pokedataPrice - justTcgPrice) / justTcgPrice) * 100).toFixed(2))
        : null;

    priceComparison = {
      pokedataPrice,
      justTcgPrice: justTcgPrice ?? null,
      medianPrice: parseFloat(medianPrice.toFixed(2)),
      delta: delta !== null ? parseFloat(delta.toFixed(2)) : null,
      deltaPercent,
    };
  }

  return {
    matched,
    confidence: parseFloat(confidence.toFixed(3)),
    pokedataCardId: pokedataCard.id,
    pokedataName: pokedataCard.name,
    pokedataNumber: pokedataCard.number,
    pokedataRarity: pokedataCard.rarity ?? null,
    finishTypes,
    conditions,
    priceComparison,
  };
}

/**
 * Find the best Near Mint variant from a list of Pokedata variants.
 * Prefers NM Holofoil > NM Non-Holo > NM Reverse Holo > any NM.
 */
function findBestNmVariant(variants: PokedataVariant[]): PokedataVariant | null {
  const nmVariants = variants.filter(
    (v) => normalizeCondition(v.condition) === "nm" && v.price != null && v.price > 0,
  );
  if (nmVariants.length === 0) return null;

  // Sort by finish preference
  const scored = nmVariants.map((v) => ({
    variant: v,
    score: finishScore(mapPokedataPrinting(v.printing)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].variant;
}

function finishScore(finish: string): number {
  if (finish === "HOLO") return 30;
  if (finish === "NON_HOLO") return 20;
  if (finish === "REVERSE_HOLO") return 10;
  return 0;
}

// ── Batch enrichment ─────────────────────────────────────────────────────────

export type EnrichmentResult = {
  canonical_slug: string;
  classification: ClassificationResult;
};

/**
 * Enrich a batch of canonical cards with Pokedata classification data.
 * Takes pre-fetched Pokedata cards and canonical metadata.
 */
export function enrichBatch(
  pokedataCards: PokedataCard[],
  canonicals: Array<{
    slug: string;
    name: string;
    number: string;
    justTcgPrice?: number | null;
  }>,
): EnrichmentResult[] {
  const results: EnrichmentResult[] = [];

  // Index Pokedata cards by normalized number for fast lookup
  const byNumber = new Map<string, PokedataCard[]>();
  for (const card of pokedataCards) {
    const num = normalizeCardNumber(card.number);
    if (!num) continue;
    const existing = byNumber.get(num) ?? [];
    existing.push(card);
    byNumber.set(num, existing);
  }

  for (const canonical of canonicals) {
    const canNum = normalizeCardNumber(canonical.number);
    const candidates = byNumber.get(canNum) ?? [];

    if (candidates.length === 0) {
      results.push({
        canonical_slug: canonical.slug,
        classification: {
          matched: false,
          confidence: 0,
          pokedataCardId: null,
          pokedataName: null,
          pokedataNumber: null,
          pokedataRarity: null,
          finishTypes: [],
          conditions: [],
          priceComparison: null,
        },
      });
      continue;
    }

    // Score each candidate and pick best
    let bestClassification: ClassificationResult | null = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      const classification = classifyFromPokedata(
        candidate,
        canonical.name,
        canonical.number,
        canonical.justTcgPrice,
      );
      if (classification.confidence > bestScore) {
        bestScore = classification.confidence;
        bestClassification = classification;
      }
    }

    results.push({
      canonical_slug: canonical.slug,
      classification: bestClassification!,
    });
  }

  return results;
}
