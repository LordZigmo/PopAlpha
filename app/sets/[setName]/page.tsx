import Link from "next/link";
import { notFound } from "next/navigation";
import { getSetSummaryPageData } from "@/lib/sets/summary";
import { dbPublic } from "@/lib/db";

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
  median_7d: number | null;
};

type CardEntry = {
  slug: string;
  name: string;
  cardNumber: string | null;
  imageUrl: string | null;
  rawPrice: number | null;
};

function formatUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 2 : 0,
    maximumFractionDigits: value < 1 ? 2 : digits,
  }).format(value);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? null;
}

function trendSummary(change7dPct: number | null, change30dPct: number | null): { title: string; detail: string } {
  if (change7dPct !== null && Number.isFinite(change7dPct)) {
    if (change7dPct >= 8) return { title: "Rising", detail: `${change7dPct.toFixed(1)}% over 7D` };
    if (change7dPct >= 2) return { title: "Leaning Up", detail: `${change7dPct.toFixed(1)}% over 7D` };
    if (change7dPct <= -8) return { title: "Cooling Off", detail: `${Math.abs(change7dPct).toFixed(1)}% down over 7D` };
    if (change7dPct <= -2) return { title: "Softening", detail: `${Math.abs(change7dPct).toFixed(1)}% down over 7D` };
    return { title: "Steady", detail: `${change7dPct.toFixed(1)}% over 7D` };
  }

  if (change30dPct !== null && Number.isFinite(change30dPct)) {
    if (change30dPct >= 8) return { title: "Rising", detail: `${change30dPct.toFixed(1)}% over 30D` };
    if (change30dPct <= -8) return { title: "Cooling Off", detail: `${Math.abs(change30dPct).toFixed(1)}% down over 30D` };
    return { title: "Mixed", detail: `${change30dPct.toFixed(1)}% over 30D` };
  }

  return { title: "Forming", detail: "Not enough recent price data" };
}

function changeTone(changePct: number | null): string {
  if (changePct === null || !Number.isFinite(changePct) || changePct === 0) return "var(--color-text-muted)";
  return changePct > 0 ? "#00DC5A" : "#FF3B30";
}

function formatChange(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

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
  const supabase = dbPublic();
  const summary = await getSetSummaryPageData(decodedSetName);

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
      .from("card_metrics")
      .select("canonical_slug, median_7d")
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
    priceBySlug.set(p.canonical_slug, p.median_7d);
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

  const pricedEntries = entries.filter((entry) => entry.rawPrice !== null && Number.isFinite(entry.rawPrice));
  const pricedValues = pricedEntries
    .map((entry) => Number(entry.rawPrice))
    .filter((value) => Number.isFinite(value));
  const topCard = pricedEntries[0] ?? null;
  const pricedCount = pricedEntries.length;
  const pricingCoveragePct = cards.length > 0 ? (pricedCount / cards.length) * 100 : 0;
  const medianPrice = median(pricedValues);
  const trend = trendSummary(summary.snapshot?.change7dPct ?? null, summary.snapshot?.change30dPct ?? null);
  const primaryTrendChange = summary.snapshot?.change7dPct ?? summary.snapshot?.change30dPct ?? null;

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-5 flex items-baseline gap-3">
          <Link href="/sets" className="text-muted text-sm transition-colors hover:text-app">
            ← Sets
          </Link>
          <h1 className="text-app text-xl font-semibold">{decodedSetName}</h1>
          <span className="text-muted text-xs">{cards.length} cards</span>
        </div>

        {summary.snapshot ? (
          <section className="mb-6 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/30 p-4">
                <p className="text-muted text-[11px] uppercase tracking-[0.18em]">Top Chase</p>
                <p className="mt-2 text-app truncate text-lg font-semibold">
                  {topCard ? topCard.name : "No pricing yet"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {topCard ? `${formatUsd(topCard.rawPrice)} RAW` : "Waiting on tracked pricing"}
                </p>
              </div>
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/30 p-4">
                <p className="text-muted text-[11px] uppercase tracking-[0.18em]">Cards With Pricing</p>
                <p className="mt-2 text-app text-lg font-semibold">
                  {pricedCount} / {cards.length}
                </p>
                <p className="mt-1 text-xs text-muted">{pricingCoveragePct.toFixed(0)}% of the set is priced</p>
              </div>
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/30 p-4">
                <p className="text-muted text-[11px] uppercase tracking-[0.18em]">Typical Card</p>
                <p className="mt-2 text-app text-lg font-semibold">{formatUsd(medianPrice)}</p>
                <p className="mt-1 text-xs text-muted">Median RAW price across tracked cards</p>
              </div>
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/30 p-4">
                <p className="text-muted text-[11px] uppercase tracking-[0.18em]">Set Trend</p>
                <p className="mt-2 text-lg font-semibold" style={{ color: changeTone(primaryTrendChange) }}>
                  {trend.title}
                </p>
                <p className="mt-1 text-xs" style={{ color: changeTone(primaryTrendChange) }}>
                  {trend.detail}
                </p>
              </div>
            </div>

            {summary.finishBreakdown.length > 0 ? (
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/20 p-4">
                <p className="text-muted text-[11px] uppercase tracking-[0.18em]">Pricing By Finish</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {summary.finishBreakdown.map((row) => (
                    <div key={row.finish} className="rounded-[var(--radius-input)] border-app border bg-surface/20 px-3 py-2">
                      <p className="text-app text-sm font-semibold">{row.finish.replaceAll("_", " ")}</p>
                      <p className="text-xs text-muted">
                        {formatUsd(row.marketCap)} tracked value · {row.cardCount} cards
                      </p>
                      {formatChange(row.change7dPct ?? row.change30dPct) ? (
                        <p
                          className="mt-1 text-xs font-semibold"
                          style={{ color: changeTone(row.change7dPct ?? row.change30dPct) }}
                        >
                          {formatChange(row.change7dPct ?? row.change30dPct)} {row.change7dPct != null ? "over 7D" : "over 30D"}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section>
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
