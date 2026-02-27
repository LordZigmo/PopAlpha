import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type DeckRow = {
  id: string;
  name: string;
  format: string | null;
  release_year: number | null;
  image_url: string | null;
};

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

  const { data: deck } = await supabase
    .from("decks")
    .select("id, name, format, release_year, image_url")
    .eq("id", id)
    .maybeSingle<DeckRow>();

  if (!deck) notFound();

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

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-app text-2xl font-semibold">{deck.name}</p>
              <p className="text-muted mt-1 text-sm">
                {deck.format ?? "Format unknown"}
                {deck.release_year ? ` • ${deck.release_year}` : ""}
              </p>
            </div>
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface-soft">
              {deck.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={deck.image_url} alt={deck.name} className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full bg-surface-soft" />
              )}
            </div>
          </div>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-center justify-between gap-3">
            <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Cards List</p>
            <span className="text-muted text-xs">{deckCards.length} entries</span>
          </div>

          {deckCards.length === 0 ? (
            <p className="text-muted mt-3 text-sm">No deck cards stored yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[color:var(--color-border)] text-muted text-xs uppercase tracking-[0.08em]">
                    <th className="py-2 pr-3 font-semibold">Qty</th>
                    <th className="py-2 pr-3 font-semibold">Card</th>
                    <th className="py-2 font-semibold">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {deckCards.map((row) => {
                    const canonicalSlug = resolvedBySourceId.get(row.card_source_id) ?? null;
                    return (
                      <tr key={`${row.deck_id}-${row.card_source}-${row.card_source_id}`} className="border-b border-[color:var(--color-border)]/60">
                        <td className="py-3 pr-3 text-app font-semibold">{row.qty}</td>
                        <td className="py-3 pr-3">
                          {canonicalSlug ? (
                            <Link href={`/c/${encodeURIComponent(canonicalSlug)}`} className="text-app underline underline-offset-4">
                              {row.card_source_id}
                            </Link>
                          ) : (
                            <span className="text-app">{row.card_source_id}</span>
                          )}
                        </td>
                        <td className="py-3 text-muted">{row.card_source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
