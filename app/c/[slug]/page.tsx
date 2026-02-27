import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import EbayListings from "@/components/ebay-listings";

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

type GradeSelection = "RAW" | "PSA9" | "PSA10";

const GRADE_OPTIONS: GradeSelection[] = ["RAW", "PSA9", "PSA10"];

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

function gradeLabel(grade: GradeSelection): string {
  if (grade === "PSA9") return "PSA 9";
  if (grade === "PSA10") return "PSA 10";
  return "Raw";
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

function buildQuery(base: CanonicalCardRow, printing: CardPrintingRow | null, grade: GradeSelection): string {
  const parts: string[] = [];
  if (base.canonical_name) parts.push(base.canonical_name);
  if (base.set_name) parts.push(base.set_name);
  if (base.card_number) parts.push(base.card_number);
  if (printing?.edition === "FIRST_EDITION") parts.push("1st edition");
  if (printing?.finish === "REVERSE_HOLO") parts.push("reverse holo");
  if (printing?.finish === "HOLO") parts.push("holo");
  if (grade === "PSA9") parts.push("PSA 9");
  if (grade === "PSA10") parts.push("PSA 10");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function toggleHref(slug: string, printingId: string | null, grade: GradeSelection): string {
  const params = new URLSearchParams();
  if (printingId) params.set("printing", printingId);
  if (grade !== "RAW") params.set("grade", grade);
  const qs = params.toString();
  return qs ? `/c/${encodeURIComponent(slug)}?${qs}` : `/c/${encodeURIComponent(slug)}`;
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
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!canonical) notFound();

  const { data: printingsData } = await supabase
    .from("card_printings")
    .select("id, set_name, set_code, year, card_number, language, finish, finish_detail, edition, stamp, rarity")
    .eq("canonical_slug", slug)
    .order("year", { ascending: false })
    .order("set_name", { ascending: true })
    .order("card_number", { ascending: true });

  const printings = ((printingsData ?? []) as CardPrintingRow[]).sort(sortPrintings);
  const gradeSelection = selectedGrade(grade);
  const selectedPrinting =
    printings.find((row) => row.id === printing) ??
    (printings.length > 0 ? [...printings].sort(sortPrintings)[0] : null);

  const ebayQuery = buildQuery(canonical, selectedPrinting, gradeSelection);

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-2xl font-semibold">{canonical.canonical_name}</p>
          <p className="text-muted mt-1 text-sm">{subtitle(canonical)}</p>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Printing</p>
          {printings.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No printings imported yet.</p>
          ) : (
            <>
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
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                        active ? "btn-accent" : "btn-ghost"
                      }`}
                    >
                      {label}
                    </Link>
                  );
                })}
              </div>
              <p className="text-muted mt-2 text-[11px]">Missing label? We are refining print-level labeling continuously.</p>
            </>
          )}
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Grade</p>
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
        </section>

        <EbayListings query={ebayQuery} cardVariantId={null} />
      </div>
    </main>
  );
}
