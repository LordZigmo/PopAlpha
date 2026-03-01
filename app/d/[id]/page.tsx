import { notFound, redirect } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type DeckCardRow = {
  deck_id: string;
  card_source: string;
  card_source_id: string;
  qty: number;
};

type PrintingLookupRow = {
  canonical_slug: string;
  source_id: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

export default async function DeckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = getServerSupabaseClient();

  const { data: deckCardsData } = await supabase
    .from("deck_cards")
    .select("deck_id, card_source, card_source_id, qty")
    .eq("deck_id", id)
    .order("card_source_id", { ascending: true });

  const deckCards = (deckCardsData ?? []) as DeckCardRow[];
  const sourceIds = Array.from(new Set(deckCards.map((row) => row.card_source_id).filter((value) => value.length > 0)));

  const resolvedBySourceId = new Map<string, string>();
  if (sourceIds.length > 0) {
    const orClauses = sourceIds.map((sourceId) => `source_id.like.${escapeLike(sourceId)}:%`);
    const { data: printingData } = await supabase
      .from("card_printings")
      .select("canonical_slug, source_id")
      .eq("source", "pokemon-tcg-data")
      .or(orClauses.join(","));

    const printingRows = (printingData ?? []) as PrintingLookupRow[];
    for (const row of printingRows) {
      const sourceId = row.source_id ?? "";
      const prefix = sourceId.split(":")[0];
      if (prefix && row.canonical_slug && !resolvedBySourceId.has(prefix)) {
        resolvedBySourceId.set(prefix, row.canonical_slug);
      }
    }
  }

  const canonicalSlug = deckCards
    .map((row) => resolvedBySourceId.get(row.card_source_id) ?? null)
    .find((value) => !!value);

  if (!canonicalSlug) {
    notFound();
  }

  redirect(`/cards/${encodeURIComponent(canonicalSlug)}`);
}
