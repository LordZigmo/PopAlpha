import Link from "next/link";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type SetEntry = {
  set_name: string;
  year: number | null;
  count: number;
};

export const revalidate = 3600;

export default async function SetsPage() {
  const supabase = getServerSupabaseClient();

  const { data: rows } = await supabase
    .from("canonical_cards")
    .select("set_name, year")
    .not("set_name", "is", null)
    .limit(30000);

  // Group by set_name + year in JS
  const setMap = new Map<string, SetEntry>();
  for (const row of rows ?? []) {
    if (!row.set_name) continue;
    const key = `${row.set_name}||${row.year ?? "null"}`;
    const existing = setMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      setMap.set(key, { set_name: row.set_name, year: row.year, count: 1 });
    }
  }

  const sets = Array.from(setMap.values()).sort((a, b) => {
    if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
    return a.set_name.localeCompare(b.set_name);
  });

  // Group by year for display
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
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-app text-xl font-semibold">Sets</p>
              <p className="text-muted mt-1 text-sm">
                {sets.length} sets · Browse cards sorted by market value
              </p>
            </div>
            <Link href="/" className="text-muted text-sm transition-colors hover:text-app">
              ← Home
            </Link>
          </div>
        </section>

        <div className="mt-4 space-y-6">
          {yearGroups.map(([year, yearSets]) => (
            <section key={year}>
              <p className="text-muted mb-2 text-xs font-semibold uppercase tracking-[0.12em]">{year}</p>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {yearSets.map((s) => (
                  <Link
                    key={s.set_name}
                    href={`/sets/${encodeURIComponent(s.set_name)}`}
                    className="glass group flex items-center justify-between rounded-[var(--radius-card)] border-app border px-4 py-3 transition duration-150 hover:bg-surface-soft/30"
                  >
                    <div className="min-w-0">
                      <p className="text-app truncate text-sm font-semibold">{s.set_name}</p>
                      <p className="text-muted mt-0.5 text-xs">{s.count} cards</p>
                    </div>
                    <span className="text-muted ml-3 shrink-0 text-xs font-semibold transition-colors group-hover:text-app">
                      Browse →
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
