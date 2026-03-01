import Link from "next/link";
import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { measureAsync } from "@/lib/perf";
import SearchResultsSection from "@/components/search-results-section";
import { parseSearchSort } from "@/lib/search/sort.mjs";

type SearchSort = "relevance" | "newest" | "oldest";

type SearchParams = {
  q?: string;
  page?: string;
  lang?: string;
  set?: string;
  sort?: string;
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
  image_url: string | null;
};

type SnapshotPriceRow = {
  canonical_slug: string;
  median_7d: number | null;
};

type GroupedSearchRow = {
  canonical: CanonicalCardRow;
  printings: PrintingRow[];
  rawPrice: number | null;
};

type SearchResultBundle = {
  rows: GroupedSearchRow[];
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

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 2)
    )
  );
}

function extractCardNumber(query: string): string | null {
  const slashMatch = query.match(/(?:^|\s)#?(\d{1,4})\s*\/\s*\d+(?:\s|$)/i);
  if (slashMatch) return slashMatch[1];
  const hashMatch = query.match(/(?:^|\s)#(\d{1,4})(?:\s|$)/i);
  if (hashMatch) return hashMatch[1];
  return null;
}

function extractNameHint(query: string): string {
  return query
    .replace(/#?\d+\s*\/\s*\d+/g, " ")
    .replace(/#\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelySubjectQuery(query: string): boolean {
  if (/\d/.test(query)) return false;
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.length <= 2;
}

function isGenericNameQuery(query: string): boolean {
  if (query.length > 40) return false;
  if (/[0-9#/]/.test(query)) return false;
  if (!/^[a-z'\-\s]+$/.test(query)) return false;
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.length <= 3;
}

function hasSlashCardPattern(query: string): boolean {
  return /(?:^|\s)#?\d{1,4}\s*\/\s*\d+(?:\s|$)/i.test(query);
}

function hasHashCardPattern(query: string): boolean {
  return /(?:^|\s)#\s*\d{1,4}(?:\s|$)/i.test(query);
}

function hasSetLikeHint(query: string): boolean {
  if (/\b\d{4}\b/.test(query)) return true;
  return /[a-z]{3,}/i.test(query);
}

function shouldAllowStructuredRedirect(query: string): boolean {
  if (hasSlashCardPattern(query)) return true;
  if (hasHashCardPattern(query) && hasSetLikeHint(query)) return true;
  return false;
}

function scoreCanonicalMatch(
  row: CanonicalCardRow,
  qLower: string,
  tokens: string[],
  parsedNumber: string | null,
  subjectMode: boolean,
  genericNameMode: boolean
): number {
  const canonicalName = (row.canonical_name ?? "").toLowerCase();
  const subject = (row.subject ?? "").toLowerCase();
  const setName = (row.set_name ?? "").toLowerCase();
  const cardNumber = (row.card_number ?? "").toLowerCase();
  const searchable = [canonicalName, subject, setName, cardNumber, (row.variant ?? "").toLowerCase(), (row.language ?? "").toLowerCase()]
    .filter((value) => value.length > 0)
    .join(" ");
  let score = 0;

  if (subjectMode && subject === qLower) score += 700;
  if (subjectMode && subject.startsWith(qLower)) score += 560;
  if (genericNameMode && canonicalName === qLower) score += 520;
  if (canonicalName.startsWith(qLower)) score += genericNameMode ? 440 : 360;
  if (subject.includes(qLower)) score += genericNameMode ? 320 : 220;
  if (canonicalName.includes(qLower)) score += genericNameMode ? 280 : 200;
  if (setName.includes(qLower)) score += 110;
  if (parsedNumber && cardNumber === parsedNumber.toLowerCase()) score += 150;
  for (const token of tokens) {
    if (subject === token) score += 170;
    else if (subject.startsWith(token)) score += 120;
    else if (subject.includes(token)) score += 90;

    if (canonicalName === token) score += 150;
    else if (canonicalName.startsWith(token)) score += 105;
    else if (canonicalName.includes(token)) score += 75;

    if (setName === token) score += 80;
    else if (setName.includes(token)) score += 55;

    if (searchable.includes(token)) score += 20;
  }

  return score;
}

function primaryPrintingRank(printing: PrintingRow): number {
  let score = 0;
  if (printing.image_url) score += 300;
  if (printing.language.toUpperCase() === "EN") score += 80;
  if (printing.finish !== "UNKNOWN") score += 50;
  if (printing.finish === "HOLO") score += 15;
  if (printing.edition === "FIRST_EDITION") score += 10;
  return score;
}

function choosePrimaryPrinting(printings: PrintingRow[]): PrintingRow | null {
  if (printings.length === 0) return null;
  return [...printings].sort((a, b) => primaryPrintingRank(b) - primaryPrintingRank(a) || a.id.localeCompare(b.id))[0] ?? null;
}

async function runBroadSearch(params: {
  q: string;
  page: number;
  lang: string;
  setFilter: string;
  parsedNumber: string | null;
}): Promise<SearchResultBundle> {
  const { q, page, lang, setFilter, parsedNumber } = params;
  const supabase = getServerSupabaseClient();
  const qLower = normalizeQuery(q);
  const tokens = tokenizeQuery(qLower);
  const subjectMode = isLikelySubjectQuery(qLower);
  const genericNameMode = isGenericNameQuery(qLower);
  const yearValue = /^\d{4}$/.test(qLower) ? Number.parseInt(qLower, 10) : null;

  const fields = "slug, canonical_name, subject, set_name, year, card_number, language, variant";
  const startsPattern = `${qLower}%`;
  const containsPattern = `%${qLower}%`;
  const searchTerms = [qLower, ...tokens.filter((token) => token !== qLower)];
  const broadOrParts = [
    `canonical_name.ilike.${containsPattern}`,
    `subject.ilike.${containsPattern}`,
    `set_name.ilike.${containsPattern}`,
    `card_number.ilike.${containsPattern}`,
    `variant.ilike.${containsPattern}`,
    `language.ilike.${containsPattern}`,
  ];
  if (yearValue !== null) broadOrParts.push(`year.eq.${yearValue}`);
  if (parsedNumber) broadOrParts.push(`card_number.eq.${parsedNumber}`);
  for (const term of searchTerms) {
    const termPattern = `%${term}%`;
    broadOrParts.push(
      `canonical_name.ilike.${termPattern}`,
      `subject.ilike.${termPattern}`,
      `set_name.ilike.${termPattern}`,
      `variant.ilike.${termPattern}`
    );
  }
  if (genericNameMode && tokens.length > 0) {
    broadOrParts.length = 0;
    for (const term of searchTerms) {
      const termPattern = `%${term}%`;
      broadOrParts.push(`canonical_name.ilike.${termPattern}`, `subject.ilike.${termPattern}`, `set_name.ilike.${termPattern}`);
    }
  }

  let subjectStartsQuery = supabase
    .from("canonical_cards")
    .select(fields)
    .ilike("subject", startsPattern)
    .order("subject", { ascending: true })
    .limit(350);

  let nameStartsQuery = supabase
    .from("canonical_cards")
    .select(fields)
    .ilike("canonical_name", startsPattern)
    .order("canonical_name", { ascending: true })
    .limit(350);

  let containsQuery = supabase
    .from("canonical_cards")
    .select(fields)
    .or(broadOrParts.join(","))
    .order("canonical_name", { ascending: true })
    .limit(500);

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
  if (parsedNumber) printOrParts.push(`card_number.eq.${parsedNumber}`);
  for (const term of searchTerms) {
    const termPattern = `%${term}%`;
    printOrParts.push(
      `set_name.ilike.${termPattern}`,
      `card_number.ilike.${termPattern}`,
      `finish.ilike.${termPattern}`,
      `finish_detail.ilike.${termPattern}`,
      `edition.ilike.${termPattern}`,
      `stamp.ilike.${termPattern}`,
      `rarity.ilike.${termPattern}`,
      `language.ilike.${termPattern}`
    );
  }

  let printingQuery = supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, card_number, language, finish, finish_detail, edition, stamp, image_url")
    .or(printOrParts.join(","))
    .order("canonical_slug", { ascending: true })
    .limit(600);

  if (lang !== "ALL") {
    subjectStartsQuery = subjectStartsQuery.ilike("language", lang);
    nameStartsQuery = nameStartsQuery.ilike("language", lang);
    containsQuery = containsQuery.ilike("language", lang);
    printingQuery = printingQuery.ilike("language", lang);
  }
  if (setFilter) {
    subjectStartsQuery = subjectStartsQuery.ilike("set_name", `%${setFilter}%`);
    nameStartsQuery = nameStartsQuery.ilike("set_name", `%${setFilter}%`);
    containsQuery = containsQuery.ilike("set_name", `%${setFilter}%`);
    printingQuery = printingQuery.ilike("set_name", `%${setFilter}%`);
  }

  const [{ data: subjectRowsRaw }, { data: startsRowsRaw }, { data: containsRowsRaw }, { data: matchedPrintingsRaw }] = await Promise.all([
    subjectStartsQuery,
    nameStartsQuery,
    containsQuery,
    printingQuery,
  ]);

  const subjectRows = (subjectRowsRaw ?? []) as CanonicalCardRow[];
  const startsRows = (startsRowsRaw ?? []) as CanonicalCardRow[];
  const containsRows = (containsRowsRaw ?? []) as CanonicalCardRow[];
  const matchedPrintings = (matchedPrintingsRaw ?? []) as PrintingRow[];

  const canonicalBySlug = new Map<string, CanonicalCardRow>();
  const scoreBySlug = new Map<string, number>();

  const applyRowScore = (row: CanonicalCardRow, baseScore: number) => {
    canonicalBySlug.set(row.slug, row);
    const computed = scoreCanonicalMatch(row, qLower, tokens, parsedNumber, subjectMode, genericNameMode) + baseScore;
    scoreBySlug.set(row.slug, Math.max(scoreBySlug.get(row.slug) ?? 0, computed));
  };

  for (const row of subjectRows) applyRowScore(row, 300);
  for (const row of startsRows) applyRowScore(row, 220);
  for (const row of containsRows) applyRowScore(row, 120);
  for (const printing of matchedPrintings) {
    scoreBySlug.set(printing.canonical_slug, Math.max(scoreBySlug.get(printing.canonical_slug) ?? 0, 75));
  }

  const orderedSlugs = Array.from(scoreBySlug.keys()).sort((a, b) => {
    const scoreA = scoreBySlug.get(a) ?? 0;
    const scoreB = scoreBySlug.get(b) ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
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
    const { data: missingRows } = await supabase.from("canonical_cards").select(fields).in("slug", missingSlugs);
    for (const row of (missingRows ?? []) as CanonicalCardRow[]) {
      canonicalBySlug.set(row.slug, row);
    }
  }

  let pagePrintingsQuery = supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, card_number, language, finish, finish_detail, edition, stamp, image_url")
    .in("canonical_slug", pageSlugs)
    .order("set_name", { ascending: true })
    .order("card_number", { ascending: true });

  if (lang !== "ALL") pagePrintingsQuery = pagePrintingsQuery.ilike("language", lang);
  if (setFilter) pagePrintingsQuery = pagePrintingsQuery.ilike("set_name", `%${setFilter}%`);
  const [{ data: pagePrintingsRaw }, { data: pagePricesRaw }] = await Promise.all([
    pagePrintingsQuery,
    supabase
      .from("card_metrics")
      .select("canonical_slug, median_7d")
      .in("canonical_slug", pageSlugs)
      .eq("grade", "RAW")
      .is("printing_id", null),
  ]);
  const pagePrintings = (pagePrintingsRaw ?? []) as PrintingRow[];
  const printingsBySlug = new Map<string, PrintingRow[]>();
  for (const printing of pagePrintings) {
    const current = printingsBySlug.get(printing.canonical_slug) ?? [];
    current.push(printing);
    printingsBySlug.set(printing.canonical_slug, current);
  }

  const priceBySlug = new Map<string, number | null>();
  for (const p of (pagePricesRaw ?? []) as SnapshotPriceRow[]) {
    priceBySlug.set(p.canonical_slug, p.median_7d);
  }

  const rows: GroupedSearchRow[] = pageSlugs
    .map((slug) => {
      const canonical = canonicalBySlug.get(slug);
      if (!canonical) return null;
      return {
        canonical,
        printings: printingsBySlug.get(slug) ?? [],
        rawPrice: priceBySlug.get(slug) ?? null,
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
  parsedNumber: string | null;
}) {
  const { q, page, lang, setFilter, parsedNumber } = params;
  return unstable_cache(
    () =>
      measureAsync("search.broad", { q, page, lang, setFilter, parsedNumber }, () =>
        runBroadSearch({
          q,
          page,
          lang,
          setFilter,
          parsedNumber,
        })
      ),
    ["search-v2", q.toLowerCase(), String(page), lang.toLowerCase(), setFilter.toLowerCase(), parsedNumber ?? "none"],
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
  const qNormalized = normalizeQuery(q);
  const parsedNumber = extractCardNumber(qNormalized);
  const nameHint = extractNameHint(qNormalized);
  const page = toPositiveInt(params.page, 1);
  const lang = (params.lang ?? "all").trim().toUpperCase();
  const setFilter = (params.set ?? "").trim();
  const sort = parseSearchSort(params.sort) as SearchSort;
  const genericNameMode = isGenericNameQuery(qNormalized);
  let exactMatchSuggestion: { href: string; label: string } | null = null;

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

  if (/^\d+$/.test(qNormalized)) {
    redirect(`/cert/${encodeURIComponent(qNormalized)}`);
  }

  const supabase = getServerSupabaseClient();

  const { data: printingAliasRow } = await measureAsync("search.printing_alias", { q: qNormalized }, async () =>
    supabase
      .from("printing_aliases")
      .select("printing_id")
      .eq("alias", qNormalized)
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
      const href = `/cards/${encodeURIComponent(printingRow.canonical_slug)}?printing=${encodeURIComponent(printingAliasRow.printing_id)}`;
      if (!genericNameMode) {
        redirect(href);
      }
      const { data: exactCanonicalRow } = await supabase
        .from("canonical_cards")
        .select("canonical_name")
        .eq("slug", printingRow.canonical_slug)
        .maybeSingle<{ canonical_name: string }>();
      if (exactCanonicalRow?.canonical_name) {
        exactMatchSuggestion = {
          href,
          label: exactCanonicalRow.canonical_name,
        };
      }
    }
  }

  const { data: aliasRow } = await measureAsync("search.alias", { q: qNormalized }, async () =>
    supabase
      .from("card_aliases")
      .select("canonical_slug")
      .eq("alias", qNormalized)
      .limit(1)
      .maybeSingle<{ canonical_slug: string }>()
  );
  if (aliasRow?.canonical_slug) {
    const href = `/cards/${encodeURIComponent(aliasRow.canonical_slug)}`;
    if (!genericNameMode) {
      redirect(href);
    }
    if (!exactMatchSuggestion) {
      const { data: exactCanonicalRow } = await supabase
        .from("canonical_cards")
        .select("canonical_name")
        .eq("slug", aliasRow.canonical_slug)
        .maybeSingle<{ canonical_name: string }>();
      if (exactCanonicalRow?.canonical_name) {
        exactMatchSuggestion = {
          href,
          label: exactCanonicalRow.canonical_name,
        };
      }
    }
  }

  // Redirect to a single canonical card only when the query is explicitly card-like, not for broad name searches.
  if (parsedNumber && !genericNameMode && shouldAllowStructuredRedirect(qNormalized)) {
    let inferredSetHint = setFilter;
    let inferredNameHint = nameHint;
    if (!inferredSetHint) {
      const { data: setHintRow } = await supabase
        .from("canonical_cards")
        .select("set_name")
        .ilike("set_name", `%${qNormalized}%`)
        .limit(1)
        .maybeSingle<{ set_name: string | null }>();
      inferredSetHint = setHintRow?.set_name ?? "";
    }
    if (!inferredSetHint) {
      const tokens = nameHint.split(/\s+/).filter((token) => token.length > 0);
      if (tokens.length >= 3) {
        inferredSetHint = tokens.slice(0, 2).join(" ");
        inferredNameHint = tokens.slice(2).join(" ");
      }
    }

    if (hasSlashCardPattern(qNormalized)) {
      let slashMatchQuery = supabase
        .from("card_printings")
        .select("canonical_slug")
        .ilike("finish_detail", `%${qNormalized}%`)
        .limit(3);

      if (inferredSetHint) slashMatchQuery = slashMatchQuery.ilike("set_name", `%${inferredSetHint}%`);

      const slashMatches = await measureAsync("search.structured_slash", { q: qNormalized }, async () => {
        const { data } = await slashMatchQuery;
        return Array.from(new Set(((data ?? []) as Array<{ canonical_slug: string }>).map((row) => row.canonical_slug)));
      });

      if (slashMatches.length === 1) {
        redirect(`/cards/${encodeURIComponent(slashMatches[0])}`);
      }
    }

    let structuredQuery = supabase
      .from("canonical_cards")
      .select("slug")
      .eq("card_number", parsedNumber)
      .limit(3);

    if (inferredSetHint) structuredQuery = structuredQuery.ilike("set_name", `%${inferredSetHint}%`);
    if (inferredNameHint) {
      structuredQuery = structuredQuery.or(`canonical_name.ilike.%${inferredNameHint}%,subject.ilike.%${inferredNameHint}%`);
    }

    const matches = await measureAsync("search.structured", { q: qNormalized, parsedNumber }, async () => {
      const { data } = await structuredQuery;
      return (data ?? []) as Array<{ slug: string }>;
    });
    if (matches.length === 1) {
      redirect(`/cards/${encodeURIComponent(matches[0].slug)}`);
    }
  }

  const result = await getCachedBroadSearch({
    q: qNormalized,
    page,
    lang,
    setFilter,
    parsedNumber,
  });

  const startIndex = result.total === 0 ? 0 : (result.page - 1) * PAGE_SIZE + 1;
  const endIndex = result.total === 0 ? 0 : startIndex + result.rows.length - 1;
  const displayRows = result.rows.map((row) => {
    const primaryPrinting = choosePrimaryPrinting(row.printings);
    return {
      canonical_slug: row.canonical.slug,
      canonical_name: row.canonical.canonical_name,
      set_name: row.canonical.set_name,
      year: row.canonical.year,
      raw_price: row.rawPrice,
      primary_image_url: primaryPrinting?.image_url ?? null,
    };
  });

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-xl font-semibold">Results for “{q}”</p>
          <p className="text-muted mt-1 text-sm">
            {result.total} matches {result.total > 0 ? `• Showing ${startIndex}-${endIndex}` : ""}
          </p>
          {genericNameMode ? <p className="text-muted mt-1 text-xs">Showing canonical matches for: {q}</p> : null}
          {exactMatchSuggestion ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border-app border bg-surface-soft/45 px-3 py-1.5 text-xs">
              <span className="text-muted">Go to exact match:</span>
              <Link href={exactMatchSuggestion.href} className="text-app font-semibold underline underline-offset-4">
                {exactMatchSuggestion.label}
              </Link>
            </div>
          ) : null}

          <form action="/search" className="sticky top-2 z-10 mt-4 grid gap-2 rounded-[var(--radius-card)] bg-surface/85 p-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input type="hidden" name="q" value={q} />
            <input type="hidden" name="sort" value={sort} />
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
        <SearchResultsSection
          key={`${q}-${sort}-${result.page}-${lang}-${setFilter}`}
          rows={displayRows}
          total={result.total}
          page={result.page}
          totalPages={result.totalPages}
          genericNameMode={genericNameMode}
          initialSort={sort}
          currentParams={{
            q,
            page: String(result.page),
            lang: lang.toLowerCase(),
            set: setFilter,
            sort,
          }}
        />
      </div>
    </main>
  );
}
