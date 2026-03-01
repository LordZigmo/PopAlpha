import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { measureAsync } from "@/lib/perf";

export const runtime = "nodejs";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
};

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function scoreText(value: string | null | undefined, query: string): number {
  const text = (value ?? "").toLowerCase();
  if (!text) return 0;
  if (text.startsWith(query)) return 2;
  if (text.includes(query)) return 1;
  return 0;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = normalizeQuery(url.searchParams.get("q") ?? "");
  if (!q) {
    return NextResponse.json({ ok: true, cards: [], decks: [] });
  }

  const supabase = getServerSupabaseClient();
  const containsPattern = `%${q}%`;

  const cardsRaw = await measureAsync("search.suggest.cards", { q }, async () => {
    const { data } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, card_number, year")
      .or(`canonical_name.ilike.${containsPattern},set_name.ilike.${containsPattern},card_number.ilike.${containsPattern}`)
      .limit(24);
    return (data ?? []) as CanonicalCardRow[];
  });

  const cards = cardsRaw
    .sort((a, b) => {
      const scoreA = scoreText(a.canonical_name, q) * 10 + scoreText(a.set_name, q);
      const scoreB = scoreText(b.canonical_name, q) * 10 + scoreText(b.set_name, q);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.canonical_name.localeCompare(b.canonical_name);
    })
    .slice(0, 8);

  return NextResponse.json({
    ok: true,
    cards,
    decks: [],
  });
}
