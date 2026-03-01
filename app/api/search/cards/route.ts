import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { buildSearchCardResults } from "@/lib/search/cards.mjs";
import { normalizeSearchInput } from "@/lib/search/normalize.mjs";

export const runtime = "nodejs";

const RESULT_LIMIT = 20;
const FETCH_LIMIT = 80;

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
  supabase: ReturnType<typeof getServerSupabaseClient>,
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
  supabase: ReturnType<typeof getServerSupabaseClient>,
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

  const supabase = getServerSupabaseClient();
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
    })),
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
    }));
  }

  const canonicalRows = dedupeBySlug([...directRows, ...aliasCanonicalRows]);

  const cards = buildSearchCardResults({
    canonicalRows,
    aliasRows,
    query: normalized,
    limit: RESULT_LIMIT,
  });

  return NextResponse.json({ ok: true, cards });
}
