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

function applyTokenFilters<T>(query: T, tokens: string[]): T {
  let next = query;
  for (const token of tokens) {
    next = (next as { ilike: (column: string, pattern: string) => T }).ilike("search_doc_norm", `%${token}%`);
  }
  return next;
}

function applyAliasTokenFilters<T>(query: T, tokens: string[]): T {
  let next = query;
  for (const token of tokens) {
    next = (next as { ilike: (column: string, pattern: string) => T }).ilike("alias_norm", `%${token}%`);
  }
  return next;
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const normalized = normalizeSearchInput(q);

  if (!normalized.normalized_text) {
    return NextResponse.json({ ok: true, cards: [] });
  }

  const supabase = getServerSupabaseClient();
  const [directTokenResult, aliasTokenResult] = await Promise.all([
    applyTokenFilters(
      supabase
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, card_number, year, primary_image_url, search_doc_norm")
        .limit(FETCH_LIMIT),
      normalized.tokens,
    ),
    applyAliasTokenFilters(
      supabase
        .from("card_aliases")
        .select("canonical_slug, alias_norm")
        .limit(FETCH_LIMIT),
      normalized.tokens,
    ),
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
