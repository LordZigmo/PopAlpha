import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import CardWatchlistButton from "@/components/card-watchlist-button";

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

function subtitle(row: CanonicalCardRow): string {
  const bits: string[] = [];
  if (row.year) bits.push(String(row.year));
  if (row.set_name) bits.push(row.set_name);
  if (row.card_number) bits.push(`#${row.card_number}`);
  if (row.variant) bits.push(row.variant);
  if (row.language) bits.push(row.language);
  return bits.join(" • ");
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = getServerSupabaseClient();

  const { data } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!data) {
    notFound();
  }

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-center justify-between gap-3">
            <p className="text-app text-2xl font-semibold">{data.canonical_name}</p>
            <CardWatchlistButton slug={data.slug} title={data.canonical_name} />
          </div>
          <p className="text-muted mt-1 text-sm">{subtitle(data)}</p>
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
