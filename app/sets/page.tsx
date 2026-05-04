import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/layout/PageShell";
import { buildSetId } from "@/lib/sets/summary-core.mjs";
import { dbPublic } from "@/lib/db";
import { isPhysicalPokemonSet } from "@/lib/sets/physical";

const title = "Sets | PopAlpha";
const description = "Browse Pokemon card sets with live market heat, recent movement, and set-level summaries.";
const canonicalPath = "/sets";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: canonicalPath,
  },
  openGraph: {
    title,
    description,
    url: canonicalPath,
    siteName: "PopAlpha",
    type: "website",
    images: [
      { url: "/opengraph-image", alt: "PopAlpha" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/twitter-image"],
  },
};

type SetEntry = {
  set_name: string;
  year: number | null;
  card_count: number;
  set_id?: string | null;
  change_7d_pct?: number | null;
  change_30d_pct?: number | null;
  heat_score?: number | null;
  unknown_finish_count: number;
  summary?: {
    card_count: number;
    change_7d_pct: number | null;
    change_30d_pct: number | null;
    heat_score: number | null;
  };
};

export const dynamic = "force-dynamic";

export default async function SetsPage() {
  const supabase = dbPublic();

  const { data: latestSnapshot } = await supabase
    .from("public_set_summaries")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1);

  const latestAsOf = latestSnapshot?.[0]?.as_of_date ?? null;

  const { data: snapshotRows } = latestAsOf
    ? await supabase
        .from("public_set_summaries")
        .select("set_name, as_of_date, change_7d_pct, change_30d_pct, heat_score")
        .eq("as_of_date", latestAsOf)
    : { data: null };

  const summaryMap = new Map<string, SetEntry["summary"]>();
  for (const row of snapshotRows ?? []) {
    const key = row.set_name;
    if (!key) continue;
    summaryMap.set(key, {
      card_count: 0,
      change_7d_pct: row.change_7d_pct,
      change_30d_pct: row.change_30d_pct,
      heat_score: row.heat_score,
    });
  }

  const catalogResponse = await supabase
    .from("canonical_set_catalog")
    .select("set_name, year, card_count")
    .order("year", { ascending: false })
    .order("set_name", { ascending: true });

  type CatalogRow = { set_name: string | null; year: number | null; card_count: number | null };
  let catalogRows: CatalogRow[] = catalogResponse.data ?? [];

  if (catalogResponse.error || catalogRows.length === 0) {
    const fallback = await supabase
      .from("canonical_cards")
      .select("set_name, year")
      .not("set_name", "is", null)
      .limit(30000);
    const map = new Map<string, { set_name: string; year: number | null; card_count: number }>();
    for (const row of (fallback.data ?? []) as { set_name: string | null; year: number | null }[]) {
      if (!row.set_name) continue;
      const key = `${row.set_name}||${row.year ?? "null"}`;
      const existing = map.get(key);
      if (existing) {
        existing.card_count += 1;
      } else {
        map.set(key, { set_name: row.set_name, year: row.year, card_count: 1 });
      }
    }
    catalogRows = Array.from(map.values()).map((entry) => ({
      set_name: entry.set_name,
      year: entry.year,
      card_count: entry.card_count,
    }));
  }

  const sets: SetEntry[] = [];
  for (const entry of catalogRows) {
    if (!entry?.set_name) continue;
    if (!isPhysicalPokemonSet({ setName: entry.set_name })) continue;
    const key = entry.set_name;
    const summary = key ? summaryMap.get(key) : undefined;
    sets.push({
      set_name: entry.set_name,
      year: entry.year,
      card_count: entry.card_count ?? 0,
      set_id: buildSetId(entry.set_name),
      change_7d_pct: summary?.change_7d_pct ?? null,
      change_30d_pct: summary?.change_30d_pct ?? null,
      heat_score: summary?.heat_score ?? null,
      unknown_finish_count: 0,
      summary: summary,
    });
  }

  const byYear = new Map<string, SetEntry[]>();
  for (const s of sets) {
    const yearKey = s.year ? String(s.year) : "Unknown";
    const existing = byYear.get(yearKey) ?? [];
    existing.push(s);
    byYear.set(yearKey, existing);
  }

  const yearGroups = Array.from(byYear.entries()).sort(([a], [b]) => {
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    return Number(b) - Number(a);
  });

  return (
    <PageShell>
      <div className="px-5 py-8 sm:px-8">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-app text-xl font-semibold">Sets</p>
              <p className="text-muted mt-1 text-sm">
                {sets.length} sets · Browse cards sorted by market value
              </p>
            </div>
          </div>
        </section>

        <div className="mt-4 space-y-6">
          {yearGroups.map(([year, yearSets]) => (
            <section key={year}>
              <p className="text-muted mb-2 text-xs font-semibold uppercase tracking-[0.12em]">{year}</p>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {yearSets.map((s) => {
                  const hasPricing = Boolean(s.summary);
                  const signalPositive = hasPricing;
                  const signalLabel = signalPositive ? "Market Live" : "Needs data";
                  const signalClass = signalPositive ? "glow-signal-positive" : "glow-signal-negative";
                  return (
                    <Link
                      key={`${s.set_name}-${s.year ?? "x"}`}
                      href={`/sets/${encodeURIComponent(s.set_name)}`}
                      className="glass group flex items-center justify-between rounded-[var(--radius-card)] border-app border px-4 py-3 transition duration-150 hover:bg-surface-soft/30"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`glow-signal ${signalClass}`} />
                          <p className="text-app truncate text-sm font-semibold">{s.set_name}</p>
                        </div>
                        <p className="text-muted mt-0.5 text-xs">{s.card_count} cards</p>
                        <p className="text-muted text-[0.6rem] uppercase tracking-[0.2em]">{signalLabel}</p>
                      </div>
                      <span className="text-muted ml-3 shrink-0 text-xs font-semibold transition-colors group-hover:text-app">
                        Browse →
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
