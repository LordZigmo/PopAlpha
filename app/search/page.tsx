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

type PrintingRow = {
  id: string;
  canonical_slug: string;
  set_name: string | null;
  card_number: string;
  language: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
};

type GroupedSearchRow = {
  canonical: CanonicalCardRow;
  printings: PrintingRow[];
};

type SearchResultBundle = {
  rows: GroupedSearchRow[];
  total: number;
  page: number;
  totalPages: number;
};

type IdentityCardRow = {
  id: string;
  slug: string;
  name: string;
  set: string;
  year: number;
  number: string;
  image_url: string | null;
};

type VariantChipRow = {
  card_id: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
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

function printingChipLabel(printing: PrintingRow): string {
  const finishMap: Record<PrintingRow["finish"], string> = {
    NON_HOLO: "Non-Holo",
    HOLO: "Holo",
    REVERSE_HOLO: "Reverse Holo",
    ALT_HOLO: "Alt Holo",
    UNKNOWN: "Unknown",
  };
  const bits: string[] = [finishMap[printing.finish]];
  if (printing.edition === "FIRST_EDITION") bits.push("1st Ed");
  if (printing.stamp) bits.push(printing.stamp);
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

  let startsDataQuery = supabase
    .from("canonical_cards")
    .select(fields)
    .ilike("canonical_name", startsPattern)
    .order("canonical_name", { ascending: true })
    .limit(300);

  let containsDataQuery = supabase
    .from("canonical_cards")
    .select(fields)
    .or(broadOrParts.join(","))
    .not("canonical_name", "ilike", startsPattern);

  containsDataQuery = containsDataQuery.order("canonical_name", { ascending: true }).limit(400);

  const printOrParts = [
    `set_name.ilike.${containsPattern}`,
    `card_number.ilike.${containsPattern}`,
    `finish.ilike.${containsPattern}`,
    `finish_detail.ilike.${containsPattern}`,
    `edition.ilike.${containsPattern}`,
    `stamp.ilike.${containsPattern}`,
    `rarity.ilike.${containsPattern}`,
    `language.ilike.${containsPattern}`,
  ];
  if (yearValue !== null) printOrParts.push(`year.eq.${yearValue}`);

  let printingQuery = supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, card_number, language, finish, finish_detail, edition, stamp")
    .or(printOrParts.join(","))
    .order("canonical_slug", { ascending: true })
    .limit(500);

  if (lang !== "ALL") {
    startsDataQuery = startsDataQuery.ilike("language", lang);
    containsDataQuery = containsDataQuery.ilike("language", lang);
    printingQuery = printingQuery.ilike("language", lang);
  }
  if (setFilter) {
    startsDataQuery = startsDataQuery.ilike("set_name", `%${setFilter}%`);
    containsDataQuery = containsDataQuery.ilike("set_name", `%${setFilter}%`);
    printingQuery = printingQuery.ilike("set_name", `%${setFilter}%`);
  }

  const [{ data: startsRowsRaw }, { data: containsRowsRaw }, { data: matchedPrintingsRaw }] = await Promise.all([
    startsDataQuery,
    containsDataQuery,
    printingQuery,
  ]);

  const startsRows = (startsRowsRaw ?? []) as CanonicalCardRow[];
  const containsRows = (containsRowsRaw ?? []) as CanonicalCardRow[];
  const matchedPrintings = (matchedPrintingsRaw ?? []) as PrintingRow[];

  const priorityBySlug = new Map<string, number>();
  const canonicalBySlug = new Map<string, CanonicalCardRow>();

  for (const row of startsRows) {
    priorityBySlug.set(row.slug, Math.max(priorityBySlug.get(row.slug) ?? 0, 3));
    canonicalBySlug.set(row.slug, row);
  }
  for (const row of containsRows) {
    priorityBySlug.set(row.slug, Math.max(priorityBySlug.get(row.slug) ?? 0, 2));
    canonicalBySlug.set(row.slug, row);
  }
  for (const printing of matchedPrintings) {
    priorityBySlug.set(printing.canonical_slug, Math.max(priorityBySlug.get(printing.canonical_slug) ?? 0, 1));
  }

  const orderedSlugs = Array.from(priorityBySlug.keys()).sort((a, b) => {
    const priorityA = priorityBySlug.get(a) ?? 0;
    const priorityB = priorityBySlug.get(b) ?? 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    const nameA = canonicalBySlug.get(a)?.canonical_name ?? a;
    const nameB = canonicalBySlug.get(b)?.canonical_name ?? b;
    return nameA.localeCompare(nameB);
  });

  const total = orderedSlugs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const boundedPage = Math.min(page, totalPages);
  const offset = (boundedPage - 1) * PAGE_SIZE;
  const pageSlugs = orderedSlugs.slice(offset, offset + PAGE_SIZE);
  const missingSlugs = pageSlugs.filter((slug) => !canonicalBySlug.has(slug));
  if (missingSlugs.length > 0) {
    const { data: missingRows } = await supabase
      .from("canonical_cards")
      .select(fields)
      .in("slug", missingSlugs);
    for (const row of (missingRows ?? []) as CanonicalCardRow[]) {
      canonicalBySlug.set(row.slug, row);
    }
  }

  let pagePrintingsQuery = supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, card_number, language, finish, finish_detail, edition, stamp")
    .in("canonical_slug", pageSlugs)
    .order("set_name", { ascending: true })
    .order("card_number", { ascending: true });

  if (lang !== "ALL") pagePrintingsQuery = pagePrintingsQuery.ilike("language", lang);
  if (setFilter) pagePrintingsQuery = pagePrintingsQuery.ilike("set_name", `%${setFilter}%`);
  const { data: pagePrintingsRaw } = await pagePrintingsQuery;
  const pagePrintings = (pagePrintingsRaw ?? []) as PrintingRow[];
  const printingsBySlug = new Map<string, PrintingRow[]>();
  for (const printing of pagePrintings) {
    const current = printingsBySlug.get(printing.canonical_slug) ?? [];
    current.push(printing);
    printingsBySlug.set(printing.canonical_slug, current);
  }

  const rows: GroupedSearchRow[] = pageSlugs
    .map((slug) => {
      const canonical = canonicalBySlug.get(slug);
      if (!canonical) return null;
      return {
        canonical,
        printings: printingsBySlug.get(slug) ?? [],
      };
    })
    .filter((row): row is GroupedSearchRow => row !== null);

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

  const { data: printingAliasRow } = await measureAsync("search.printing_alias", { q }, async () =>
    supabase
      .from("printing_aliases")
      .select("printing_id")
      .ilike("alias", q)
      .limit(1)
      .maybeSingle<{ printing_id: string }>()
  );

  if (printingAliasRow?.printing_id) {
    const { data: printingRow } = await supabase
      .from("card_printings")
      .select("canonical_slug")
      .eq("id", printingAliasRow.printing_id)
      .maybeSingle<{ canonical_slug: string }>();

    if (printingRow?.canonical_slug) {
      redirect(`/cards/${encodeURIComponent(printingRow.canonical_slug)}?printing=${encodeURIComponent(printingAliasRow.printing_id)}`);
    }
  }

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

  let cardsQuery = supabase
    .from("cards")
    .select("id, slug, name, set, year, number, image_url")
    .or(`name.ilike.%${q}%,set.ilike.%${q}%,number.ilike.%${q}%`)
    .order("name", { ascending: true })
    .limit(25);
  if (setFilter) cardsQuery = cardsQuery.ilike("set", `%${setFilter}%`);
  const { data: cardRowsRaw } = await cardsQuery;
  const cardRows = (cardRowsRaw ?? []) as IdentityCardRow[];
  const cardIds = cardRows.map((row) => row.id);
  let variantRows: VariantChipRow[] = [];
  if (cardIds.length > 0) {
    const { data: variantsRaw } = await supabase
      .from("card_variants")
      .select("card_id, finish, edition")
      .in("card_id", cardIds);
    variantRows = (variantsRaw ?? []) as VariantChipRow[];
  }

  const chipsByCardId = new Map<string, string[]>();
  for (const variant of variantRows) {
    const chips = chipsByCardId.get(variant.card_id) ?? [];
    if (variant.finish === "HOLO" && !chips.includes("Holo")) chips.push("Holo");
    if (variant.finish === "REVERSE_HOLO" && !chips.includes("Reverse")) chips.push("Reverse");
    if (variant.edition === "FIRST_EDITION" && !chips.includes("1st Ed")) chips.push("1st Ed");
    chipsByCardId.set(variant.card_id, chips.slice(0, 3));
  }

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
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Card DB Matches</p>
          {cardRows.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No direct card matches.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[color:var(--color-border)]">
              {cardRows.map((card) => (
                <li key={card.id}>
                  <Link
                    href={`/c/${encodeURIComponent(card.slug)}`}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-app truncate text-sm font-semibold">{card.name}</p>
                      <p className="text-muted truncate text-xs">
                        {card.year || "—"} • {card.set} • #{card.number}
                      </p>
                      {(chipsByCardId.get(card.id) ?? []).length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(chipsByCardId.get(card.id) ?? []).slice(0, 3).map((chip) => (
                            <span key={`${card.id}-${chip}`} className="border-app rounded-full border px-2 py-0.5 text-[11px] text-muted">
                              {chip}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <span className="text-muted text-xs font-semibold">View</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
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
                <li key={row.canonical.slug}>
                  <Link
                    href={`/cards/${encodeURIComponent(row.canonical.slug)}`}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-app truncate text-sm font-semibold">{row.canonical.canonical_name}</p>
                      <p className="text-muted truncate text-xs">{rowSubtitle(row.canonical)}</p>
                      {row.printings.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {row.printings.slice(0, 4).map((printing) => (
                            <span key={printing.id} className="border-app rounded-full border px-2 py-0.5 text-[11px] text-muted">
                              {printingChipLabel(printing)}
                            </span>
                          ))}
                        </div>
                      ) : null}
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
