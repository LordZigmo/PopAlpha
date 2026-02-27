import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type SearchParams = {
  q?: string;
  page?: string;
  lang?: string;
  set?: string;
};

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

const PAGE_SIZE = 25;

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function scoreCard(row: CanonicalCardRow, q: string): number {
  const lowerQ = q.toLowerCase();
  const canonical = (row.canonical_name ?? "").toLowerCase();
  const subject = (row.subject ?? "").toLowerCase();
  const setName = (row.set_name ?? "").toLowerCase();
  const cardNum = (row.card_number ?? "").toLowerCase();

  if (canonical.startsWith(lowerQ)) return 0;
  if (subject.startsWith(lowerQ)) return 1;
  if (setName.startsWith(lowerQ) || cardNum.startsWith(lowerQ)) return 2;
  return 3;
}

function rowSubtitle(row: CanonicalCardRow): string {
  const bits: string[] = [];
  if (row.year) bits.push(String(row.year));
  if (row.set_name) bits.push(row.set_name);
  if (row.card_number) bits.push(`#${row.card_number}`);
  if (row.variant) bits.push(row.variant);
  if (row.language) bits.push(row.language);
  return bits.join(" • ");
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const page = toPositiveInt(params.page, 1);
  const lang = (params.lang ?? "all").trim().toUpperCase();
  const setFilter = (params.set ?? "").trim().toLowerCase();

  if (!q) {
    return (
      <main className="app-shell">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
            <p className="text-app text-lg font-semibold">Search</p>
            <p className="text-muted mt-2 text-sm">Enter a card name or alias to browse canonical card profiles.</p>
          </section>
        </div>
      </main>
    );
  }

  if (/^\d+$/.test(q)) {
    redirect(`/cert/${encodeURIComponent(q)}`);
  }

  const supabase = getServerSupabaseClient();

  const { data: aliasRow } = await supabase
    .from("card_aliases")
    .select("canonical_slug")
    .ilike("alias", q)
    .limit(1)
    .maybeSingle<{ canonical_slug: string }>();

  if (aliasRow?.canonical_slug) {
    redirect(`/cards/${encodeURIComponent(aliasRow.canonical_slug)}`);
  }

  let query = supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant")
    .or(
      [
        `canonical_name.ilike.%${q}%`,
        `subject.ilike.%${q}%`,
        `set_name.ilike.%${q}%`,
        `card_number.ilike.%${q}%`,
        `variant.ilike.%${q}%`,
        `language.ilike.%${q}%`,
      ].join(",")
    )
    .limit(500);

  if (lang !== "ALL") {
    query = query.ilike("language", lang);
  }

  const { data } = await query;
  const rows = ((data ?? []) as CanonicalCardRow[]).filter((row) => {
    if (!setFilter) return true;
    return (row.set_name ?? "").toLowerCase().includes(setFilter);
  });

  rows.sort((a, b) => {
    const sa = scoreCard(a, q);
    const sb = scoreCard(b, q);
    if (sa !== sb) return sa - sb;
    return a.canonical_name.localeCompare(b.canonical_name);
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const boundedPage = Math.min(page, totalPages);
  const start = (boundedPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const prevHref =
    boundedPage > 1
      ? `/search?q=${encodeURIComponent(q)}&page=${boundedPage - 1}&lang=${encodeURIComponent(lang.toLowerCase())}&set=${encodeURIComponent(setFilter)}`
      : null;
  const nextHref =
    boundedPage < totalPages
      ? `/search?q=${encodeURIComponent(q)}&page=${boundedPage + 1}&lang=${encodeURIComponent(lang.toLowerCase())}&set=${encodeURIComponent(setFilter)}`
      : null;

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-xl font-semibold">Results for “{q}”</p>
          <p className="text-muted mt-1 text-sm">{total} matches</p>

          <form action="/search" className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input type="hidden" name="q" value={q} />
            <input
              name="set"
              defaultValue={setFilter}
              placeholder="Filter set name"
              className="input-themed h-10 rounded-[var(--radius-input)] px-3 text-sm"
            />
            <select
              name="lang"
              defaultValue={lang.toLowerCase()}
              className="input-themed h-10 rounded-[var(--radius-input)] px-3 text-sm"
            >
              <option value="all">Language: All</option>
              <option value="en">EN</option>
              <option value="jp">JP</option>
            </select>
            <input type="hidden" name="page" value="1" />
            <button type="submit" className="btn-accent h-10 rounded-[var(--radius-input)] px-4 text-sm font-semibold">
              Apply
            </button>
          </form>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          {pageRows.length === 0 ? (
            <div>
              <p className="text-app text-sm font-semibold">No matches found.</p>
              <p className="text-muted mt-1 text-sm">Try adding set name, year, or card number.</p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {pageRows.map((row) => (
                <li key={row.slug}>
                  <Link
                    href={`/cards/${encodeURIComponent(row.slug)}`}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-app truncate text-sm font-semibold">{row.canonical_name}</p>
                      <p className="text-muted truncate text-xs">{rowSubtitle(row)}</p>
                    </div>
                    <span className="text-muted text-xs font-semibold">View</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex items-center justify-between">
            <span className="text-muted text-xs">
              Page {boundedPage} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              {prevHref ? (
                <Link href={prevHref} className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs">
                  Prev
                </Link>
              ) : (
                <span className="border-app rounded-[var(--radius-input)] border px-3 py-1.5 text-xs text-muted">Prev</span>
              )}
              {nextHref ? (
                <Link href={nextHref} className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs">
                  Next
                </Link>
              ) : (
                <span className="border-app rounded-[var(--radius-input)] border px-3 py-1.5 text-xs text-muted">Next</span>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

