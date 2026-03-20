import Image from "next/image";
import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";
import { getCanonicalMarketPulseMap, type CanonicalMarketPulse } from "@/lib/data/market";
import { dbPublic } from "@/lib/db";
import { measureAsync } from "@/lib/perf";
import SearchResultsSection from "@/components/search-results-section";
import CardSearch from "@/components/card-search";
import PokeTraceCameraBetaPanel from "@/components/poketrace-camera-beta-panel";
import { POKETRACE_CAMERA_HREF } from "@/lib/poketrace/ui-paths";
import { parseSearchSort, sortSearchResults } from "@/lib/search/sort.mjs";
import { getLatestSetSummarySnapshot, type SetSummarySnapshot } from "@/lib/sets/summary";

type SearchSort = "relevance" | "market-price" | "newest" | "oldest";

type SearchParams = {
  q?: string;
  intent?: string;
  page?: string;
  pageSize?: string;
  lang?: string;
  set?: string;
  sort?: string;
  priced?: string;
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

type GroupedSearchRow = {
  canonical: CanonicalCardRow;
  printings: PrintingRow[];
  rawPrice: number | null;
  changePct: number | null;
  changeWindow: "24H" | "7D" | null;
};

type SearchResultBundle = {
  rows: GroupedSearchRow[];
  total: number;
  page: number;
  totalPages: number;
};

type SearchDisplayRow = {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  raw_price: number | null;
  change_pct: number | null;
  change_window: "24H" | "7D" | null;
  primary_image_url: string | null;
};

const DEFAULT_PAGE_SIZE = 24;
const ALLOWED_PAGE_SIZES = new Set([24, 48, 96]);

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePageSize(value: string | undefined): number {
  const parsed = toPositiveInt(value, DEFAULT_PAGE_SIZE);
  return ALLOWED_PAGE_SIZES.has(parsed) ? parsed : DEFAULT_PAGE_SIZE;
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

function hasUsableMarketData(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

async function runBroadSearch(params: {
  q: string;
  page: number;
  pageSize: number;
  lang: string;
  setFilter: string;
  parsedNumber: string | null;
  sort: SearchSort;
  pricedOnly: boolean;
}): Promise<SearchResultBundle> {
  const { q, page, pageSize, lang, setFilter, parsedNumber, sort, pricedOnly } = params;
  const supabase = dbPublic();
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

  const relevanceOrderedSlugs = Array.from(scoreBySlug.keys()).sort((a, b) => {
    const scoreA = scoreBySlug.get(a) ?? 0;
    const scoreB = scoreBySlug.get(b) ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const nameA = canonicalBySlug.get(a)?.canonical_name ?? a;
    const nameB = canonicalBySlug.get(b)?.canonical_name ?? b;
    return nameA.localeCompare(nameB);
  });

  const needsAllPrices = relevanceOrderedSlugs.length > 0 && (sort === "market-price" || pricedOnly);
  let allMarketPulseBySlug = new Map<string, CanonicalMarketPulse>();

  if (needsAllPrices) {
    allMarketPulseBySlug = await getCanonicalMarketPulseMap(supabase, relevanceOrderedSlugs);
  }

  const filteredRelevanceSlugs = pricedOnly
    ? relevanceOrderedSlugs.filter((slug) => {
        return hasUsableMarketData(allMarketPulseBySlug.get(slug)?.marketPrice ?? null);
      })
    : relevanceOrderedSlugs;

  const orderedSlugs =
    filteredRelevanceSlugs.length === 0
      ? []
      : sort === "relevance"
        ? filteredRelevanceSlugs
        : sortSearchResults(
            sort === "market-price"
              ? filteredRelevanceSlugs.map((slug) => {
                  const row = canonicalBySlug.get(slug);
                  return {
                    canonical_slug: slug,
                    canonical_name: row?.canonical_name ?? slug,
                    set_name: row?.set_name ?? null,
                    year: row?.year ?? null,
                    raw_price: allMarketPulseBySlug.get(slug)?.marketPrice ?? null,
                  };
                })
              : filteredRelevanceSlugs.map((slug) => {
                  const row = canonicalBySlug.get(slug);
                  return {
                    canonical_slug: slug,
                    canonical_name: row?.canonical_name ?? slug,
                    set_name: row?.set_name ?? null,
                    year: row?.year ?? null,
                  };
                }),
            sort,
          ).map((row) => row.canonical_slug);

  const total = orderedSlugs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const boundedPage = Math.min(page, totalPages);
  const offset = (boundedPage - 1) * pageSize;
  const pageSlugs = orderedSlugs.slice(offset, offset + pageSize);
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
  const [pagePrintingsResult, pageMarketPulseBySlug] = await Promise.all([
    pagePrintingsQuery,
    needsAllPrices
      ? Promise.resolve(new Map(pageSlugs.map((slug) => [slug, allMarketPulseBySlug.get(slug) ?? null])))
      : getCanonicalMarketPulseMap(supabase, pageSlugs),
  ]);
  const pagePrintingsRaw = pagePrintingsResult.data;
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
      const marketPulse = pageMarketPulseBySlug.get(slug) ?? null;
      if (!canonical) return null;
      return {
        canonical,
        printings: printingsBySlug.get(slug) ?? [],
        rawPrice: marketPulse?.marketPrice ?? null,
        changePct: marketPulse?.changePct ?? null,
        changeWindow: marketPulse?.changeWindow ?? null,
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
  pageSize: number;
  lang: string;
  setFilter: string;
  parsedNumber: string | null;
  sort: SearchSort;
  pricedOnly: boolean;
}) {
  const { q, page, pageSize, lang, setFilter, parsedNumber, sort, pricedOnly } = params;
  return unstable_cache(
    () =>
      measureAsync("search.broad", { q, page, pageSize, lang, setFilter, parsedNumber, sort, pricedOnly }, () =>
        runBroadSearch({
          q,
          page,
          pageSize,
          lang,
          setFilter,
          parsedNumber,
          sort,
          pricedOnly,
        })
      ),
    [
      "search-v2",
      q.toLowerCase(),
      String(page),
      String(pageSize),
      lang.toLowerCase(),
      setFilter.toLowerCase(),
      parsedNumber ?? "none",
      sort,
      pricedOnly ? "priced-only" : "all-results",
    ],
    { revalidate: 60 }
  )();
}

async function loadSetSearchEnhancements(setName: string): Promise<{
  setSummary: SetSummarySnapshot | null;
  chaseCards: SearchDisplayRow[];
}> {
  const supabase = dbPublic();
  const [setSummary, canonicalRowsResult] = await Promise.all([
    getLatestSetSummarySnapshot(setName),
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year")
      .eq("set_name", setName),
  ]);

  const canonicalRows = (canonicalRowsResult.data ?? []) as Array<{
    slug: string;
    canonical_name: string;
    set_name: string | null;
    year: number | null;
  }>;

  if (canonicalRows.length === 0) {
    return { setSummary, chaseCards: [] };
  }

  const slugs = canonicalRows.map((row) => row.slug);
  const [marketPulseBySlug, printingRowsResult] = await Promise.all([
    getCanonicalMarketPulseMap(supabase, slugs),
    supabase
      .from("card_printings")
      .select("id, canonical_slug, set_name, card_number, language, finish, finish_detail, edition, stamp, image_url")
      .in("canonical_slug", slugs)
      .eq("language", "EN"),
  ]);

  const printingsBySlug = new Map<string, PrintingRow[]>();
  for (const printing of (printingRowsResult.data ?? []) as PrintingRow[]) {
    const bucket = printingsBySlug.get(printing.canonical_slug) ?? [];
    bucket.push(printing);
    printingsBySlug.set(printing.canonical_slug, bucket);
  }

  const chaseCards = sortSearchResults(
    canonicalRows.map((row) => {
      const primaryPrinting = choosePrimaryPrinting(printingsBySlug.get(row.slug) ?? []);
      const marketPulse = marketPulseBySlug.get(row.slug) ?? null;
      return {
        canonical_slug: row.slug,
        canonical_name: row.canonical_name,
        set_name: row.set_name,
        year: row.year,
        raw_price: marketPulse?.marketPrice ?? null,
        change_pct: marketPulse?.changePct ?? null,
        change_window: marketPulse?.changeWindow ?? null,
        primary_image_url: primaryPrinting?.image_url ?? null,
      };
    }),
    "market-price",
  )
    .filter((row) => row.raw_price !== null)
    .slice(0, 4);

  return {
    setSummary,
    chaseCards,
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const intent = (params.intent ?? "").trim().toLowerCase();
  const cameraIntent = intent === "camera";
  const qNormalized = normalizeQuery(q);
  const parsedNumber = extractCardNumber(qNormalized);
  const nameHint = extractNameHint(qNormalized);
  const page = toPositiveInt(params.page, 1);
  const pageSize = parsePageSize(params.pageSize);
  const lang = (params.lang ?? "all").trim().toUpperCase();
  const requestedSetFilter = (params.set ?? "").trim();
  const sort = parseSearchSort(params.sort ?? "market-price") as SearchSort;
  const pricedOnly = params.priced === "1";
  const genericNameMode = isGenericNameQuery(qNormalized);

  if (!q) {
    return (
      <main className="app-shell">
        <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
          {cameraIntent ? (
            <>
              <PokeTraceCameraBetaPanel className="mt-0" />
              <section className="mx-auto w-full max-w-3xl pt-8 text-center sm:pt-10">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7DB6FF]">
                  PokeTrace Search
                </p>
                <p className="text-muted mx-auto mt-3 max-w-2xl text-sm sm:text-base">
                  Search is still available if you want to jump straight to a card instead of using the camera beta.
                </p>

                <CardSearch
                  className="mx-auto mt-6 w-full max-w-3xl"
                  size="search"
                  placeholder="Search"
                  autoFocus={false}
                  enableGlobalShortcut
                  submitMode="active-or-search"
                  cameraHref={POKETRACE_CAMERA_HREF}
                />
              </section>
            </>
          ) : (
            <section className="mx-auto w-full max-w-3xl pt-10 text-center sm:pt-14">
              <div className="flex items-center justify-center gap-6">
                <span className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-[28px] border border-white/10 bg-black/55 shadow-[0_28px_72px_rgba(0,0,0,0.34)]">
                  <Image
                    src="/brand/popalpha-icon.svg"
                    alt=""
                    aria-hidden="true"
                    width={92}
                    height={92}
                    className="h-[5.5rem] w-[5.5rem]"
                    priority
                  />
                </span>
                <h1 className="text-app text-7xl font-semibold tracking-tight sm:text-[5.5rem]">PopAlpha</h1>
              </div>
              <p className="text-muted mx-auto mt-4 max-w-2xl text-sm sm:text-base">
                Smarter TCG Market Insights.
              </p>

              <CardSearch
                className="mx-auto mt-7 w-full max-w-3xl"
                size="search"
                placeholder="Search"
                autoFocus
                enableGlobalShortcut
                submitMode="active-or-search"
                cameraHref={POKETRACE_CAMERA_HREF}
              />
            </section>
          )}
        </div>
      </main>
    );
  }

  if (/^\d+$/.test(qNormalized)) {
    redirect(`/cert/${encodeURIComponent(qNormalized)}`);
  }

  const supabase = dbPublic();
  let setFilter = requestedSetFilter;

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
  }

  if (!setFilter && !parsedNumber && qNormalized) {
    const { data: exactSetRow } = await measureAsync("search.set_exact", { q: qNormalized }, async () =>
      supabase
        .from("canonical_cards")
        .select("set_name")
        .ilike("set_name", qNormalized)
        .limit(1)
        .maybeSingle<{ set_name: string | null }>()
    );

    if (exactSetRow?.set_name) {
      setFilter = exactSetRow.set_name;
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
    pageSize,
    lang,
    setFilter,
    parsedNumber,
    sort,
    pricedOnly,
  });

  const displayRows: SearchDisplayRow[] = result.rows.map((row) => {
    const primaryPrinting = choosePrimaryPrinting(row.printings);
    return {
      canonical_slug: row.canonical.slug,
      canonical_name: row.canonical.canonical_name,
      set_name: row.canonical.set_name,
      year: row.canonical.year,
      raw_price: row.rawPrice,
      change_pct: row.changePct,
      change_window: row.changeWindow,
      primary_image_url: primaryPrinting?.image_url ?? null,
    };
  });
  const resultSetNames = new Set(displayRows.map((r) => r.set_name).filter((s): s is string => s !== null));
  const matchedSetName = resultSetNames.size === 1 && displayRows.length >= 2 ? [...resultSetNames][0] ?? null : null;
  const { setSummary, chaseCards } = matchedSetName
    ? await loadSetSearchEnhancements(matchedSetName)
    : { setSummary: null, chaseCards: [] };

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-5">
        <section className="mx-auto w-full max-w-3xl pt-1 sm:pt-2">
          <CardSearch
            className="mx-auto w-full max-w-3xl"
            size="search"
            placeholder="Search"
            enableGlobalShortcut
            submitMode="active-or-search"
            initialValue={q}
          />
        </section>
        <SearchResultsSection
          key={`${q}-${sort}-${result.page}-${pageSize}-${lang}-${setFilter}`}
          rows={displayRows}
          chaseCards={chaseCards}
          total={result.total}
          page={result.page}
          totalPages={result.totalPages}
          initialSort={sort}
          matchedSetName={matchedSetName}
          setSummary={setSummary}
          pricedOnly={pricedOnly}
          currentParams={{
            q,
            page: String(result.page),
            pageSize: String(pageSize),
            lang: lang.toLowerCase(),
            set: setFilter,
            sort,
            priced: pricedOnly ? "1" : "",
          }}
        />
      </div>
    </main>
  );
}
