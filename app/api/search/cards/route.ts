import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";
import { loadJpPriceCoverageMap } from "@/lib/data/jp-price-coverage";
import { buildSearchCardResults } from "@/lib/search/cards.mjs";
import { normalizeSearchInput } from "@/lib/search/normalize.mjs";
import { isPhysicalPokemonSet } from "@/lib/sets/physical";

export const runtime = "nodejs";

// Character queries like "pikachu" (~244 rows) or "charizard" hit the
// physical-set filter down to ~170 results — so a 20-row cap was
// clipping 85% of legitimate matches. Trigram GIN indexes on
// search_doc_norm / alias_norm make the larger fetch cheap.
const RESULT_LIMIT = 100;
const FETCH_LIMIT = 500;

type CanonicalRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  primary_image_url: string | null;
  search_doc_norm: string;
};

type AliasRow = {
  canonical_slug: string;
  alias_norm: string;
};

function isPhysicalSearchRow(row: { set_name: string | null }): boolean {
  return isPhysicalPokemonSet({ setName: row.set_name });
}

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function applyContainsTokenFilters<T>(query: T, column: "search_doc_norm" | "alias_norm", tokens: string[]): T {
  let next = query;
  for (const token of tokens) {
    next = (next as { ilike: (column: string, pattern: string) => T }).ilike(column, `%${token}%`);
  }
  return next;
}

function applyNumericCardNumberFilters<T>(query: T, numericTokens: string[]): T {
  const clauses = Array.from(
    new Set(
      numericTokens.flatMap((token) => [
        `card_number.eq.${token}`,
        `card_number.ilike.${token}/%`,
      ]),
    ),
  );

  if (clauses.length === 0) return query;

  return (query as { or: (filters: string) => T }).or(clauses.join(","));
}

function emptyResult() {
  return Promise.resolve({ data: [], error: null });
}

function dedupeBySlug<T extends { canonical_slug: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.canonical_slug)) continue;
    seen.add(row.canonical_slug);
    deduped.push(row);
  }
  return deduped;
}

function buildDirectQuery(
  supabase: ReturnType<typeof dbPublic>,
  tokens: string[],
) {
  const textTokens = tokens.filter((token) => !isNumericToken(token));
  const numericTokens = tokens.filter((token) => isNumericToken(token));

  let query = supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, year, primary_image_url, search_doc_norm")
    .limit(FETCH_LIMIT);

  if (textTokens.length > 0) {
    query = applyContainsTokenFilters(query, "search_doc_norm", textTokens);
  } else if (numericTokens.length > 0) {
    query = applyNumericCardNumberFilters(query, numericTokens);
  }

  return query;
}

function buildAliasQuery(
  supabase: ReturnType<typeof dbPublic>,
  tokens: string[],
) {
  const textTokens = tokens.filter((token) => !isNumericToken(token));

  if (textTokens.length === 0) {
    return emptyResult();
  }

  const query = supabase
    .from("card_aliases")
    .select("canonical_slug, alias_norm")
    .limit(FETCH_LIMIT);

  return applyContainsTokenFilters(query, "alias_norm", textTokens);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const normalized = normalizeSearchInput(q);

  if (!normalized.normalized_text) {
    return NextResponse.json({ ok: true, cards: [] });
  }

  const supabase = dbPublic();
  const [directTokenResult, aliasTokenResult] = await Promise.all([
    buildDirectQuery(supabase, normalized.tokens),
    buildAliasQuery(supabase, normalized.tokens),
  ]);

  for (const result of [directTokenResult, aliasTokenResult]) {
    if (result.error) {
      return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
    }
  }

  const directRows = dedupeBySlug(
    (directTokenResult.data ?? []).map((row) => ({
      canonical_slug: row.slug,
      canonical_name: row.canonical_name,
      set_name: row.set_name,
      card_number: row.card_number,
      year: row.year,
      primary_image_url: row.primary_image_url ?? null,
      search_doc_norm: row.search_doc_norm ?? "",
    })).filter(isPhysicalSearchRow),
  ) as CanonicalRow[];

  const aliasRows = (aliasTokenResult.data ?? []) as AliasRow[];

  const missingAliasSlugs = dedupeBySlug(aliasRows)
    .map((row) => row.canonical_slug)
    .filter((slug) => !directRows.some((row) => row.canonical_slug === slug));

  let aliasCanonicalRows: CanonicalRow[] = [];
  if (missingAliasSlugs.length > 0) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, year, primary_image_url, search_doc_norm")
      .in("slug", missingAliasSlugs)
      .limit(FETCH_LIMIT);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    aliasCanonicalRows = (data ?? []).map((row) => ({
      canonical_slug: row.slug,
      canonical_name: row.canonical_name,
      set_name: row.set_name,
      card_number: row.card_number,
      year: row.year,
      primary_image_url: row.primary_image_url ?? null,
      search_doc_norm: row.search_doc_norm ?? "",
    })).filter(isPhysicalSearchRow);
  }

  const canonicalRows = dedupeBySlug([...directRows, ...aliasCanonicalRows]);

  // Rank FIRST, decorate prices after — and only for the ranked
  // results. Ranking needs no prices, and canonicalRows can be ~500
  // wide while only RESULT_LIMIT (100) ship, so loading coverage for
  // everything paid for up to 5 sequential 100-slug view queries per
  // search. public_jp_price_coverage does not push the slug predicate
  // into its subquery — every lookup materializes the full ~20.7k-row
  // view (~1.2s measured on prod, 2026-06-12) — so each avoided chunk
  // is real seconds. Post-reorder a search pays at most ONE chunk.
  const rankedCards = buildSearchCardResults({
    canonicalRows,
    aliasRows,
    query: normalized,
    limit: RESULT_LIMIT,
  });

  // Fail-soft: price decoration must never take search down. Under
  // load the coverage view intermittently exceeds the DB statement
  // timeout; before this, the loader's throw 500'd the whole search
  // (observed in prod 2026-06-12, "Error: public_jp_price_coverage:
  // …"). Results with a missing price beat no results — null price
  // is honest, a 500 is not.
  let jpPriceCoverageBySlug: Awaited<ReturnType<typeof loadJpPriceCoverageMap>>;
  try {
    jpPriceCoverageBySlug = await loadJpPriceCoverageMap(
      supabase,
      rankedCards.map((card) => card.canonical_slug),
    );
  } catch (err) {
    console.error(
      `[search/cards] price decoration failed — serving results without prices: ${err instanceof Error ? err.message : String(err)}`,
    );
    jpPriceCoverageBySlug = new Map();
  }

  const cards = rankedCards.map((card) => ({
    id: card.canonical_slug,
    name: card.canonical_name,
    set: card.set_name,
    price: jpPriceCoverageBySlug.get(card.canonical_slug)?.displayPriceUsd ?? null,
    ...card,
  }));

  return NextResponse.json({ ok: true, cards });
}
