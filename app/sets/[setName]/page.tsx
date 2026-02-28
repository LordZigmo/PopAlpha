import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  year: number | null;
  card_number: string | null;
};

type PrintingRow = {
  canonical_slug: string;
  image_url: string | null;
  language: string;
  finish: string;
  edition: string;
};

type PriceRow = {
  canonical_slug: string;
  median_ask_7d: number | null;
};

type CardEntry = {
  slug: string;
  name: string;
  cardNumber: string | null;
  imageUrl: string | null;
  rawPrice: number | null;
};

function chooseBestImage(printings: PrintingRow[]): string | null {
  if (!printings.length) return null;
  const sorted = [...printings].sort((a, b) => {
    let sa = 0,
      sb = 0;
    if (a.image_url) sa += 300;
    if (b.image_url) sb += 300;
    if (a.language?.toUpperCase() === "EN") sa += 80;
    if (b.language?.toUpperCase() === "EN") sb += 80;
    if (a.finish === "HOLO") sa += 15;
    if (b.finish === "HOLO") sb += 15;
    if (a.edition === "FIRST_EDITION") sa += 10;
    if (b.edition === "FIRST_EDITION") sb += 10;
    return sb - sa;
  });
  return sorted[0]?.image_url ?? null;
}

export default async function SetBrowserPage({ params }: { params: Promise<{ setName: string }> }) {
  const { setName } = await params;
  const decodedSetName = decodeURIComponent(setName);
  const supabase = getServerSupabaseClient();

  // Fetch all cards in this set
  const { data: cardsRaw } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, year, card_number")
    .eq("set_name", decodedSetName)
    .order("card_number", { ascending: true })
    .limit(500);

  const cards = (cardsRaw ?? []) as CanonicalRow[];
  if (!cards.length) notFound();

  const slugs = cards.map((c) => c.slug);

  // Fetch printings and prices in parallel
  const [{ data: printingsRaw }, { data: pricesRaw }] = await Promise.all([
    supabase
      .from("card_printings")
      .select("canonical_slug, image_url, language, finish, edition")
      .in("canonical_slug", slugs),
    supabase
      .from("market_snapshot_rollups")
      .select("canonical_slug, median_ask_7d")
      .in("canonical_slug", slugs)
      .eq("grade", "RAW")
      .is("printing_id", null),
  ]);

  const printings = (printingsRaw ?? []) as PrintingRow[];
  const prices = (pricesRaw ?? []) as PriceRow[];

  // Build lookup maps
  const printingsBySlug = new Map<string, PrintingRow[]>();
  for (const p of printings) {
    const cur = printingsBySlug.get(p.canonical_slug) ?? [];
    cur.push(p);
    printingsBySlug.set(p.canonical_slug, cur);
  }

  const priceBySlug = new Map<string, number | null>();
  for (const p of prices) {
    priceBySlug.set(p.canonical_slug, p.median_ask_7d);
  }

  // Build + sort card entries (price desc, then card number)
  const entries: CardEntry[] = cards.map((card) => ({
    slug: card.slug,
    name: card.canonical_name,
    cardNumber: card.card_number,
    imageUrl: chooseBestImage(printingsBySlug.get(card.slug) ?? []),
    rawPrice: priceBySlug.get(card.slug) ?? null,
  }));

  entries.sort((a, b) => {
    if (a.rawPrice != null && b.rawPrice != null) return b.rawPrice - a.rawPrice;
    if (a.rawPrice != null) return -1;
    if (b.rawPrice != null) return 1;
    return (a.cardNumber ?? "").localeCompare(b.cardNumber ?? "", undefined, { numeric: true });
  });

  const withPrice = entries.filter((e) => e.rawPrice != null).length;
  const topPrice = entries[0]?.rawPrice;

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-4">
          <Link href="/sets" className="text-muted text-sm transition-colors hover:text-app">
            ← All Sets
          </Link>
        </div>

        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-xl font-semibold">{decodedSetName}</p>
          <div className="mt-2 flex flex-wrap gap-6">
            <div>
              <p className="text-muted text-xs">Cards</p>
              <p className="text-app text-sm font-semibold">{cards.length}</p>
            </div>
            <div>
              <p className="text-muted text-xs">Priced</p>
              <p className="text-app text-sm font-semibold">{withPrice}</p>
            </div>
            {topPrice != null && (
              <div>
                <p className="text-muted text-xs">Top Card (RAW)</p>
                <p className="text-sm font-semibold" style={{ color: "var(--color-accent)" }}>
                  ${topPrice < 1 ? topPrice.toFixed(2) : topPrice.toFixed(0)}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-4">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {entries.map((entry) => (
              <Link
                key={entry.slug}
                href={`/c/${encodeURIComponent(entry.slug)}`}
                className="group block transition duration-200 hover:-translate-y-0.5"
              >
                <div className="relative aspect-[63/88] overflow-hidden rounded-[var(--radius-card)] border-app border bg-surface-soft/24">
                  {entry.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={entry.imageUrl}
                      alt={entry.name}
                      className="h-full w-full object-cover object-center transition duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_65%)] p-4">
                      <div className="rounded-[var(--radius-input)] border-app border bg-surface/35 px-3 py-2 text-center">
                        <p className="text-app text-xs font-semibold">No image</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-2 min-w-0 px-1">
                  <p className="text-app truncate text-sm font-semibold">{entry.name}</p>
                  <p className="text-muted mt-0.5 truncate text-xs">
                    {entry.cardNumber ? `#${entry.cardNumber}` : "—"}
                  </p>
                  {entry.rawPrice != null ? (
                    <p className="mt-0.5 text-xs font-semibold" style={{ color: "var(--color-accent)" }}>
                      ${entry.rawPrice < 1 ? entry.rawPrice.toFixed(2) : entry.rawPrice.toFixed(0)} RAW
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted">—</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
