import Link from "next/link";
import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { measureAsync } from "@/lib/perf";

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

type SearchResultBundle = {
  rows: CanonicalCardRow[];
  total: number;
  page: number;
  totalPages: number;
};

const PAGE_SIZE = 25;

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function runBroadSearch(params: {
  q: string;
  page: number;
  lang: string;
  setFilter: string;
}): Promise<SearchResultBundle> {
  const { q, page, lang, setFilter } = params;
  const supabase = getServerSupabaseClient();
  const yearValue = /^\d{4}$/.test(q) ? Number.parseInt(q, 10) : null;

  const fields = "slug, canonical_name, subject, set_name, year, card_number, language, variant";
  const startsPattern = `${q}%`;
  const containsPattern = `%${q}%`;
  const broadOrParts = [
    `canonical_name.ilike.${containsPattern}`,
    `subject.ilike.${containsPattern}`,
    `set_name.ilike.${containsPattern}`,
    `card_number.ilike.${containsPattern}`,
    `variant.ilike.${containsPattern}`,
    `language.ilike.${containsPattern}`,
  ];
  if (yearValue !== null) {
    broadOrParts.push(`year.eq.${yearValue}`);
  }

  let startsCountQuery = supabase
    .from("canonical_cards")
    .select("slug", { count: "exact", head: true })
    .ilike("canonical_name", startsPattern);

  let containsCountQuery = supabase
    .from("canonical_cards")
    .select("slug", { count: "exact", head: true })
    .or(broadOrParts.join(","))
    .not("canonical_name", "ilike", startsPattern);

  if (lang !== "ALL") {
    startsCountQuery = startsCountQuery.ilike("language", lang);
    containsCountQuery = containsCountQuery.ilike("language", lang);
  }
  if (setFilter) {
    startsCountQuery = startsCountQuery.ilike("set_name", `%${setFilter}%`);
    containsCountQuery = containsCountQuery.ilike("set_name", `%${setFilter}%`);
  }

  const [{ count: startsCountRaw }, { count: containsCountRaw }] = await Promise.all([
    startsCountQuery,
    containsCountQuery,
  ]);

  const startsCount = startsCountRaw ?? 0;
  const containsCount = containsCountRaw ?? 0;
  const total = startsCount + containsCount;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const boundedPage = Math.min(page, totalPages);
  const offset = (boundedPage - 1) * PAGE_SIZE;

  const rows: CanonicalCardRow[] = [];

  if (offset < startsCount) {
    const startsEnd = Math.min(offset + PAGE_SIZE - 1, startsCount - 1);
    let startsDataQuery = supabase
      .from("canonical_cards")
      .select(fields)
      .ilike("canonical_name", startsPattern)
      .order("canonical_name", { ascending: true })
      .range(offset, startsEnd);

    if (lang !== "ALL") startsDataQuery = startsDataQuery.ilike("language", lang);
    if (setFilter) startsDataQuery = startsDataQuery.ilike("set_name", `%${setFilter}%`);

    const { data: startsRows } = await startsDataQuery;
    rows.push(...((startsRows ?? []) as CanonicalCardRow[]));
  }

  if (rows.length < PAGE_SIZE) {
    const containsOffset = Math.max(offset - startsCount, 0);
    const needed = PAGE_SIZE - rows.length;
    const containsEnd = containsOffset + needed - 1;

    let containsDataQuery = supabase
      .from("canonical_cards")
      .select(fields)
      .or(broadOrParts.join(","))
      .not("canonical_name", "ilike", startsPattern)
      .order("canonical_name", { ascending: true })
      .range(containsOffset, containsEnd);

    if (lang !== "ALL") containsDataQuery = containsDataQuery.ilike("language", lang);
    if (setFilter) containsDataQuery = containsDataQuery.ilike("set_name", `%${setFilter}%`);

    const { data: containsRows } = await containsDataQuery;
    rows.push(...((containsRows ?? []) as CanonicalCardRow[]));
  }

  return {
    rows,
    total,
    page: boundedPage,
    totalPages,
  };
}

async function getCachedBroadSearch(params: {
  q: string;
  page: number;
  lang: string;
  setFilter: string;
}) {
  const { q, page, lang, setFilter } = params;
  return unstable_cache(
    () => measureAsync("search.broad", { q, page, lang, setFilter }, () => runBroadSearch(params)),
    ["search-v1", q.toLowerCase(), String(page), lang.toLowerCase(), setFilter.toLowerCase()],
    { revalidate: 60 }
  )();
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
  const setFilter = (params.set ?? "").trim();

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

  const { data: aliasRow } = await measureAsync("search.alias", { q }, async () =>
    supabase
      .from("card_aliases")
      .select("canonical_slug")
      .ilike("alias", q)
      .limit(1)
      .maybeSingle<{ canonical_slug: string }>()
  );

  if (aliasRow?.canonical_slug) {
    redirect(`/cards/${encodeURIComponent(aliasRow.canonical_slug)}`);
  }

  const result = await getCachedBroadSearch({
    q,
    page,
    lang,
    setFilter,
  });

  const startIndex = result.total === 0 ? 0 : (result.page - 1) * PAGE_SIZE + 1;
  const endIndex = result.total === 0 ? 0 : startIndex + result.rows.length - 1;

  const prevHref =
    result.page > 1
      ? `/search?q=${encodeURIComponent(q)}&page=${result.page - 1}&lang=${encodeURIComponent(lang.toLowerCase())}&set=${encodeURIComponent(setFilter)}`
      : null;
  const nextHref =
    result.page < result.totalPages
      ? `/search?q=${encodeURIComponent(q)}&page=${result.page + 1}&lang=${encodeURIComponent(lang.toLowerCase())}&set=${encodeURIComponent(setFilter)}`
      : null;

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-xl font-semibold">Results for “{q}”</p>
          <p className="text-muted mt-1 text-sm">
            {result.total} matches {result.total > 0 ? `• Showing ${startIndex}-${endIndex}` : ""}
          </p>

          <form action="/search" className="sticky top-2 z-10 mt-4 grid gap-2 rounded-[var(--radius-card)] bg-surface/85 p-2 sm:grid-cols-[1fr_auto_auto_auto]">
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
          {result.rows.length === 0 ? (
            <div>
              <p className="text-app text-sm font-semibold">No matches found.</p>
              <p className="text-muted mt-1 text-sm">Try adding set name, year, or card number.</p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {result.rows.map((row) => (
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
              Page {result.page} of {result.totalPages}
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
