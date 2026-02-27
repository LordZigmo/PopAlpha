import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import CardWatchlistButton from "@/components/card-watchlist-button";
import ShareIntelligenceButton from "@/components/share-intelligence-button";
import WatchlistCountBadge from "@/components/watchlist-count-badge";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  variant: string | null;
};

type CardPrintingRow = {
  id: string;
  set_name: string | null;
  set_code: string | null;
  year: number | null;
  card_number: string;
  language: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
  rarity: string | null;
};

function subtitle(row: CanonicalCardRow): string {
  const bits: string[] = [];
  if (row.year) bits.push(String(row.year));
  if (row.set_name) bits.push(row.set_name);
  if (row.card_number) bits.push(`#${row.card_number}`);
  if (row.variant) bits.push(row.variant);
  if (row.language) bits.push(row.language);
  return bits.join(" • ");
}

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

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ printing?: string }>;
}) {
  const { slug } = await params;
  const { printing } = await searchParams;
  const supabase = getServerSupabaseClient();

  const { data } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!data) {
    notFound();
  }

  const { data: printingsData } = await supabase
    .from("card_printings")
    .select("id, set_name, set_code, year, card_number, language, finish, finish_detail, edition, stamp, rarity")
    .eq("canonical_slug", slug)
    .order("year", { ascending: true })
    .order("set_name", { ascending: true })
    .order("card_number", { ascending: true });

  const printings = (printingsData ?? []) as CardPrintingRow[];
  const selectedPrintingId = typeof printing === "string" ? printing : "";

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-center justify-between gap-3">
            <p className="text-app text-2xl font-semibold">{data.canonical_name}</p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ShareIntelligenceButton
                title={data.canonical_name}
                grade={null}
                scarcityScore={null}
                percentHigher={null}
                populationHigher={null}
                totalPop={null}
                isOneOfOne={false}
                liquidityTier={null}
                imageUrl={null}
                fileName={`popalpha-card-${data.slug}.png`}
              />
              <CardWatchlistButton slug={data.slug} title={data.canonical_name} setName={data.set_name} year={data.year} />
              <WatchlistCountBadge />
            </div>
          </div>
          <p className="text-muted mt-1 text-sm">{subtitle(data)}</p>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Printings</p>
          {printings.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No printings imported yet.</p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {printings.map((printingRow) => (
                <li
                  key={printingRow.id}
                  className={`rounded-[var(--radius-card)] border p-[var(--space-card)] ${
                    selectedPrintingId === printingRow.id ? "border-app badge-positive" : "border-app bg-surface-soft/55"
                  }`}
                >
                  <p className="text-app text-sm font-semibold">
                    {printingRow.language} • {printingRow.set_name ?? "Unknown set"} • #{printingRow.card_number}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    {finishLabel(printingRow.finish)}
                    {printingRow.finish_detail ? ` • ${printingRow.finish_detail}` : ""}
                    {printingRow.edition !== "UNKNOWN" ? ` • ${printingRow.edition === "FIRST_EDITION" ? "1st Edition" : "Unlimited"}` : ""}
                    {printingRow.stamp ? ` • ${printingRow.stamp}` : ""}
                  </p>
                  <p className="text-muted mt-2 text-[11px]">Missing label? We are refining print-level labeling continuously.</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex flex-wrap gap-2">
            <span className="btn-accent rounded-full border px-3 py-1.5 text-xs font-semibold">Raw</span>
            <span className="btn-ghost rounded-full border px-3 py-1.5 text-xs font-semibold">PSA 10</span>
            <span className="btn-ghost rounded-full border px-3 py-1.5 text-xs font-semibold">TAG 10</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
              <p className="text-app text-sm font-semibold">Raw</p>
              <p className="text-muted mt-1 text-xs">Baseline listing data will appear here.</p>
            </div>
            <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
              <p className="text-app text-sm font-semibold">PSA 10</p>
              <p className="text-muted mt-1 text-xs">Comp stack for PSA 10 tier will be shown here.</p>
              <div className="mt-3 rounded-[var(--radius-input)] border-app border bg-surface/70 p-3">
                <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Intelligence Summary</p>
                <p className="text-muted mt-1 text-xs">Lookup a cert for live metrics.</p>
                <Link href="/" className="mt-2 inline-block text-xs underline underline-offset-4">
                  Lookup a cert for live metrics
                </Link>
              </div>
            </div>
            <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
              <p className="text-app text-sm font-semibold">TAG 10</p>
              <p className="text-muted mt-1 text-xs">TAG 10 comparables will appear when enabled.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
