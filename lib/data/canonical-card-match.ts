/**
 * Resolve a free-text VLM guess into ranked canonical_slug candidates.
 *
 * The VLM (lib/ai/card-vlm-prelabel) reads what's printed on a card
 * and returns {card_name, set_name, collector_number, ...}. None of
 * those fields directly match our canonical_slug taxonomy — slugs are
 * derived but not always identical to the printed text. This module
 * does the bridging:
 *
 *   1. If we have a clean (card_name + collector_number) pair, try
 *      exact matches against canonical_cards. Most cards land here.
 *   2. If the set_name is also confident, narrow further.
 *   3. Fall back to fuzzy name matching for the long tail (alternate
 *      spellings like "Pokemon" vs "Pokémon" in card_name, etc.).
 *   4. If still nothing, return an empty candidate list. UI lets the
 *      operator search manually.
 *
 * Returns up to 5 candidates ranked by match quality. The UI
 * highlights the top candidate and lets the operator confirm or pick
 * an alternative.
 */

import { dbAdmin } from "@/lib/db/admin";
import type { VlmCardGuess } from "@/lib/ai/card-vlm-prelabel";

export type CanonicalMatchCandidate = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  language: string | null;
  mirrored_primary_image_url: string | null;
  /** 0-1 score; 1.0 = exact triple match, lower = looser fits. */
  match_score: number;
  match_reason: string;
};

export type CanonicalMatchResult = {
  candidates: CanonicalMatchCandidate[];
  /** "exact" when a single high-confidence match. "fuzzy" when only name matched. "unmatched" when nothing usable. */
  match_quality: "exact" | "fuzzy" | "name-only" | "unmatched";
};

/**
 * Normalize a card-number string to the form stored in
 * canonical_cards.card_number. Pokemon TCG number fields can have
 * formats like "23", "023", "TG04", "SWSH062", "044/030" — we
 * preserve leading zeros where significant but strip the "/total"
 * suffix.
 */
function normalizeCardNumber(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip "/<total>" suffix if present.
  const stripped = trimmed.includes("/") ? trimmed.split("/")[0]!.trim() : trimmed;
  return stripped || null;
}

/**
 * Lowercase + collapse whitespace + strip punctuation that varies
 * across cataloging sources. Keeps apostrophes inside words ("Hop's
 * Cramorant" stays as "hop's cramorant").
 */
function normalizeName(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Replace fancy quotes / dashes with ASCII equivalents.
  return trimmed
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * Find canonical_cards candidates given the VLM's structured guess.
 *
 * Strategy (most specific to least):
 *   A. (card_name + card_number + set_name) exact triple match — rank 1.0.
 *   B. (card_name + card_number) match across sets — rank 0.85.
 *      Common when set_name was unreadable.
 *   C. (card_name + set_name) match without number — rank 0.65.
 *      Cards where the number was occluded.
 *   D. (card_name) fuzzy match — rank 0.45. Long-tail fallback.
 */
export async function findCanonicalCandidates(
  guess: VlmCardGuess,
  options: { limit?: number } = {},
): Promise<CanonicalMatchResult> {
  if (!guess.is_pokemon_tcg) {
    return { candidates: [], match_quality: "unmatched" };
  }

  const limit = options.limit ?? 5;
  const supabase = dbAdmin();

  const cardName = normalizeName(guess.card_name);
  const setName = normalizeName(guess.set_name);
  const cardNumber = normalizeCardNumber(guess.collector_number);

  if (!cardName) {
    return { candidates: [], match_quality: "unmatched" };
  }

  const candidates: CanonicalMatchCandidate[] = [];
  const seenSlugs = new Set<string>();

  const addCandidates = (
    rows: Array<{
      slug: string;
      canonical_name: string;
      set_name: string | null;
      card_number: string | null;
      language: string | null;
      mirrored_primary_image_url: string | null;
    }>,
    score: number,
    reason: string,
  ) => {
    for (const row of rows) {
      if (seenSlugs.has(row.slug)) continue;
      if (candidates.length >= limit) return;
      seenSlugs.add(row.slug);
      candidates.push({
        slug: row.slug,
        canonical_name: row.canonical_name,
        set_name: row.set_name,
        card_number: row.card_number,
        language: row.language,
        mirrored_primary_image_url: row.mirrored_primary_image_url,
        match_score: score,
        match_reason: reason,
      });
    }
  };

  // ── A. Exact triple match (name + number + set) ───────────────────
  if (cardNumber && setName) {
    const { data } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
      .ilike("canonical_name", cardName)
      .eq("card_number", cardNumber)
      .ilike("set_name", `%${setName}%`)
      .limit(limit);
    if (data && data.length > 0) {
      addCandidates(data, 1.0, "name+number+set exact");
    }
  }

  // ── B. Name + number match (set unknown / unconfident) ────────────
  if (cardNumber && candidates.length < limit) {
    const { data } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
      .ilike("canonical_name", cardName)
      .eq("card_number", cardNumber)
      .limit(limit);
    if (data && data.length > 0) {
      addCandidates(data, 0.85, "name+number");
    }
  }

  // ── C. Name + set match (number occluded) ─────────────────────────
  if (setName && candidates.length < limit) {
    const { data } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
      .ilike("canonical_name", cardName)
      .ilike("set_name", `%${setName}%`)
      .limit(limit);
    if (data && data.length > 0) {
      addCandidates(data, 0.65, "name+set");
    }
  }

  // ── D. Name fuzzy fallback ────────────────────────────────────────
  if (candidates.length < limit) {
    const fuzzy = `%${cardName}%`;
    const { data } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, language, mirrored_primary_image_url")
      .ilike("canonical_name", fuzzy)
      .limit(limit * 2);
    if (data && data.length > 0) {
      addCandidates(data, 0.45, "name-only fuzzy");
    }
  }

  let match_quality: CanonicalMatchResult["match_quality"];
  if (candidates.length === 0) {
    match_quality = "unmatched";
  } else if (candidates[0]!.match_score >= 1.0) {
    match_quality = "exact";
  } else if (candidates[0]!.match_score >= 0.65) {
    match_quality = "fuzzy";
  } else {
    match_quality = "name-only";
  }

  return { candidates, match_quality };
}
