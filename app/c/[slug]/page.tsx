import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import EbayListings from "@/components/ebay-listings";
import MarketSnapshotTiles from "@/components/market-snapshot-tiles";
import SignalBadge from "@/components/signal-badge";
import { buildEbayQuery, type GradeSelection } from "@/lib/ebay-query";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
};

type CardPrintingRow = {
  id: string;
  language: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
  image_url: string | null;
};

type SnapshotRow = {
  active_listings_7d: number | null;
  median_ask_7d: number | null;
  median_ask_30d: number | null;
  trimmed_median_30d: number | null;
  low_ask_30d: number | null;
  high_ask_30d: number | null;
};

const GRADE_OPTIONS: GradeSelection[] = ["RAW", "PSA9", "PSA10"];

function finishLabel(finish: CardPrintingRow["finish"]): string {
  const map: Record<CardPrintingRow["finish"], string> = {
    NON_HOLO: "Non-Holo",
    HOLO: "Holo",
    REVERSE_HOLO: "Reverse Holo",
    ALT_HOLO: "Alt Holo",
    UNKNOWN: "Unknown",
  };
  return map[finish];
}

function finishPriority(finish: CardPrintingRow["finish"]): number {
  const order: Record<CardPrintingRow["finish"], number> = {
    HOLO: 0,
    REVERSE_HOLO: 1,
    NON_HOLO: 2,
    ALT_HOLO: 3,
    UNKNOWN: 4,
  };
  return order[finish] ?? 9;
}

function sortPrintings(a: CardPrintingRow, b: CardPrintingRow): number {
  const finishDelta = finishPriority(a.finish) - finishPriority(b.finish);
  if (finishDelta !== 0) return finishDelta;
  if (a.edition !== b.edition) return a.edition === "FIRST_EDITION" ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function selectedGrade(gradeRaw: string | undefined): GradeSelection {
  const upper = (gradeRaw ?? "RAW").toUpperCase();
  if (upper === "PSA9" || upper === "PSA10" || upper === "RAW") return upper;
  return "RAW";
}

function gradeLabel(grade: GradeSelection): string {
  if (grade === "PSA9") return "PSA 9";
  if (grade === "PSA10") return "PSA 10";
  return "Raw";
}

function toggleHref(slug: string, printingId: string | null, grade: GradeSelection): string {
  const params = new URLSearchParams();
  if (printingId) params.set("printing", printingId);
  if (grade !== "RAW") params.set("grade", grade);
  const qs = params.toString();
  return qs ? `/c/${encodeURIComponent(slug)}?${qs}` : `/c/${encodeURIComponent(slug)}`;
}

function scarcitySignal(active7d: number | null): { label: string; tone: "positive" | "warning" | "neutral" } {
  if (active7d === null || active7d === undefined) return { label: "Scarcity signal forming", tone: "neutral" };
  if (active7d <= 2) return { label: "Scarcity: High", tone: "positive" };
  if (active7d <= 6) return { label: "Scarcity: Moderate", tone: "warning" };
  return { label: "Scarcity: Low", tone: "neutral" };
}

function liquiditySignal(active7d: number | null): { label: string; tone: "positive" | "warning" | "neutral" } {
  if (active7d === null || active7d === undefined) return { label: "Liquidity signal forming...", tone: "neutral" };
  if (active7d <= 2) return { label: "Liquidity: Thin", tone: "warning" };
  if (active7d <= 6) return { label: "Liquidity: Moderate", tone: "neutral" };
  return { label: "Liquidity: Active", tone: "positive" };
}

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Collecting";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export default async function CanonicalCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ printing?: string; grade?: string }>;
}) {
  const { slug } = await params;
  const { printing, grade } = await searchParams;
  const supabase = getServerSupabaseClient();

  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, year, card_number")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!canonical) notFound();

  const { data: printingsData } = await supabase
    .from("card_printings")
    .select("id, language, finish, finish_detail, edition, stamp, image_url")
    .eq("canonical_slug", slug);

  const printings = ((printingsData ?? []) as CardPrintingRow[]).sort(sortPrintings);
  const gradeSelection = selectedGrade(grade);
  const selectedPrinting = printings.find((row) => row.id === printing) ?? printings[0] ?? null;
  const { data: snapshotData } = await supabase
    .from("market_snapshot_rollups")
    .select("active_listings_7d, median_ask_7d, median_ask_30d, trimmed_median_30d, low_ask_30d, high_ask_30d")
    .eq("canonical_slug", slug)
    .eq("grade", gradeSelection)
    .is("printing_id", selectedPrinting?.id ?? null)
    .maybeSingle<SnapshotRow>();

  const snapshot = snapshotData
    ? {
        ok: true,
        active7d: snapshotData.active_listings_7d ?? 0,
        median7d: snapshotData.median_ask_7d,
        median30d: snapshotData.median_ask_30d,
        trimmedMedian30d: snapshotData.trimmed_median_30d,
        low30d: snapshotData.low_ask_30d,
        high30d: snapshotData.high_ask_30d,
      }
    : null;
  const scarcity = scarcitySignal(snapshotData?.active_listings_7d ?? null);
  const liquidity = liquiditySignal(snapshotData?.active_listings_7d ?? null);
  const ebayQuery = buildEbayQuery({
    canonicalName: canonical.canonical_name,
    setName: canonical.set_name,
    cardNumber: canonical.card_number,
    printing: selectedPrinting
      ? {
          finish: selectedPrinting.finish,
          edition: selectedPrinting.edition,
        }
      : null,
    grade: gradeSelection,
  });

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
            <div>
              <div className="overflow-hidden rounded-[var(--radius-card)] border-app border bg-surface-soft/45">
                {selectedPrinting?.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selectedPrinting.image_url}
                    alt={canonical.canonical_name}
                    className="h-auto max-h-[380px] w-full object-contain bg-surface/40"
                  />
                ) : (
                  <div className="flex aspect-[3/4] items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_65%)] p-6">
                    <div className="w-full rounded-[var(--radius-input)] border-app border bg-surface/40 p-6 text-center">
                      <p className="text-app text-sm font-semibold">Image pending</p>
                      <p className="text-muted mt-2 text-xs">Selected printing art will appear here when available.</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface-soft/40 p-[var(--space-card)]">
                <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.08em]">Printing Filter</p>
                {printings.length === 0 ? (
                  <p className="text-muted mt-2 text-sm">No printings imported yet.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {printings.map((row) => {
                      const label = [
                        finishLabel(row.finish),
                        row.edition === "FIRST_EDITION" ? "1st Ed" : null,
                        row.stamp,
                      ]
                        .filter((part) => Boolean(part))
                        .join(" • ");
                      const active = selectedPrinting?.id === row.id;
                      return (
                        <Link
                          key={row.id}
                          href={toggleHref(slug, row.id, gradeSelection)}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${active ? "btn-accent" : "btn-ghost"}`}
                        >
                          {label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface-soft/40 p-[var(--space-card)]">
                <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.08em]">Grade Filter</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {GRADE_OPTIONS.map((option) => {
                    const active = option === gradeSelection;
                    return (
                      <Link
                        key={option}
                        href={toggleHref(slug, selectedPrinting?.id ?? null, option)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${active ? "btn-accent" : "btn-ghost"}`}
                      >
                        {gradeLabel(option)}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>

            <div>
              <p className="text-app text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">{canonical.canonical_name}</p>
              <p className="text-muted mt-3 text-sm sm:text-base">
                {canonical.set_name ?? "Unknown set"}
                {canonical.card_number ? ` • #${canonical.card_number}` : ""}
                {canonical.year ? ` • ${canonical.year}` : ""}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <SignalBadge label={scarcity.label} tone={scarcity.tone} prominent />
                <SignalBadge label={liquidity.label} tone={liquidity.tone} prominent />
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/45 p-[var(--space-card)]">
                  <p className="text-muted text-[11px] uppercase tracking-[0.08em]">Population Snapshot</p>
                  <p className="text-app mt-2 text-xl font-semibold">
                    {snapshotData?.active_listings_7d ? `${snapshotData.active_listings_7d} live asks / 7D` : "Collecting"}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    {snapshotData?.active_listings_7d ? "Observed live supply across recent sessions." : "Waiting for enough observed listings."}
                  </p>
                </div>
                <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/45 p-[var(--space-card)]">
                  <p className="text-muted text-[11px] uppercase tracking-[0.08em]">Price Signal</p>
                  <p className="text-app mt-2 text-xl font-semibold">{formatUsdCompact(snapshotData?.median_ask_7d)}</p>
                  <p className="text-muted mt-1 text-xs">
                    {snapshotData?.median_ask_7d !== null && snapshotData?.median_ask_7d !== undefined
                      ? "Current 7-day median ask."
                      : "Collecting data from live market observations."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <MarketSnapshotTiles slug={slug} printingId={selectedPrinting?.id ?? null} grade={gradeSelection} initialData={snapshot} />

        <section className="mt-8 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Price History</p>
              <p className="text-muted mt-1 text-xs">Rolling medians update automatically as PopAlpha observes listings.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {["7D", "30D", "90D", "All"].map((range, index) => (
                <span
                  key={range}
                  className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${index === 1 ? "btn-accent" : "btn-ghost"}`}
                >
                  {range}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface-soft/35 p-[var(--space-card)]">
            <div className="h-44 rounded-[var(--radius-input)] border-app border bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:24px_24px] bg-surface/60" />
            <p className="text-app mt-3 text-sm font-semibold">Graph coming soon</p>
            <p className="text-muted mt-1 text-xs">Rolling medians update automatically as PopAlpha observes listings.</p>
          </div>
        </section>

        <EbayListings
          query={ebayQuery}
          canonicalSlug={slug}
          printingId={selectedPrinting?.id ?? null}
          grade={gradeSelection}
        />
      </div>
    </main>
  );
}
