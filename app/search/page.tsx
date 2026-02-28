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
  image_url: string | null;
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

type DeckRow = {
  id: string;
  name: string;
  format: string | null;
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

function scoreCanonicalMatch(
  row: CanonicalCardRow,
  qLower: string,
  parsedNumber: string | null,
  subjectMode: boolean,
  genericNameMode: boolean
): number {
  const canonicalName = (row.canonical_name ?? "").toLowerCase();
  const subject = (row.subject ?? "").toLowerCase();
  const setName = (row.set_name ?? "").toLowerCase();
  const cardNumber = (row.card_number ?? "").toLowerCase();
  let score = 0;

  if (subjectMode && subject === qLower) score += 700;
  if (subjectMode && subject.startsWith(qLower)) score += 560;
  if (genericNameMode && canonicalName === qLower) score += 520;
  if (canonicalName.startsWith(qLower)) score += genericNameMode ? 440 : 360;
  if (subject.includes(qLower)) score += genericNameMode ? 320 : 220;
  if (canonicalName.includes(qLower)) score += genericNameMode ? 280 : 200;
  if (setName.includes(qLower)) score += 110;
  if (parsedNumber && cardNumber === parsedNumber.toLowerCase()) score += 150;

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

function finishSummaryChips(printings: PrintingRow[]): string[] {
  const chips: string[] = [];
  for (const printing of printings) {
    if (printing.finish === "HOLO" && !chips.includes("Holo")) chips.push("Holo");
    if (printing.finish === "REVERSE_HOLO" && !chips.includes("Reverse")) chips.push("Reverse");
    if (printing.edition === "FIRST_EDITION" && !chips.includes("1st Ed")) chips.push("1st Ed");
    if (chips.length >= 3) break;
  }
  return chips;
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
  const subjectMode = isLikelySubjectQuery(qLower);
  const genericNameMode = isGenericNameQuery(qLower);
  const yearValue = /^\d{4}$/.test(qLower) ? Number.parseInt(qLower, 10) : null;

  const fields = "slug, canonical_name, subject, set_name, year, card_number, language, variant";
  const startsPattern = `${qLower}%`;
  const containsPattern = `%${qLower}%`;
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
  if (genericNameMode) {
    broadOrParts.length = 0;
    broadOrParts.push(`canonical_name.ilike.${containsPattern}`, `subject.ilike.${containsPattern}`);
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
    const computed = scoreCanonicalMatch(row, qLower, parsedNumber, subjectMode, genericNameMode) + baseScore;
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
      const href = `/c/${encodeURIComponent(printingRow.canonical_slug)}?printing=${encodeURIComponent(printingAliasRow.printing_id)}`;
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
    const href = `/c/${encodeURIComponent(aliasRow.canonical_slug)}`;
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

  const { data: deckAliasRow } = await measureAsync("search.deck_alias", { q: qNormalized }, async () =>
    supabase
      .from("deck_aliases")
      .select("deck_id")
      .eq("alias", qNormalized)
      .limit(1)
      .maybeSingle<{ deck_id: string }>()
  );
  if (deckAliasRow?.deck_id) {
    redirect(`/d/${encodeURIComponent(deckAliasRow.deck_id)}`);
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
        redirect(`/c/${encodeURIComponent(slashMatches[0])}`);
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
      redirect(`/c/${encodeURIComponent(matches[0].slug)}`);
    }
  }

  const result = await getCachedBroadSearch({
    q: qNormalized,
    page,
    lang,
    setFilter,
    parsedNumber,
  });

  const { data: deckRowsRaw } = await supabase
    .from("decks")
    .select("id, name, format")
    .ilike("name", `%${qNormalized}%`)
    .order("name", { ascending: true })
    .limit(25);
  const deckRows = (deckRowsRaw ?? []) as DeckRow[];

  let cardsQuery = supabase
    .from("cards")
    .select("id, slug, name, set, year, number, image_url")
    .or(`name.ilike.%${qNormalized}%,set.ilike.%${qNormalized}%,number.ilike.%${qNormalized}%`)
    .order("name", { ascending: true })
    .limit(25);
  if (setFilter) cardsQuery = cardsQuery.ilike("set", `%${setFilter}%`);
  const { data: cardRowsRaw } = await cardsQuery;
  const cardRows = (cardRowsRaw ?? []) as IdentityCardRow[];
  const cardIds = cardRows.map((row) => row.id);
  let variantRows: VariantChipRow[] = [];
  if (cardIds.length > 0) {
    const { data: variantsRaw } = await supabase.from("card_variants").select("card_id, finish, edition").in("card_id", cardIds);
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
            <div>
              {genericNameMode ? (
                <p className="text-muted mb-3 text-xs">Showing canonical card matches first for broad subject-name queries.</p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {result.rows.map((row) => {
                  const primaryPrinting = choosePrimaryPrinting(row.printings);
                  const chips = finishSummaryChips(row.printings);
                  return (
                    <Link
                      key={row.canonical.slug}
                      href={`/c/${encodeURIComponent(row.canonical.slug)}`}
                      className="group rounded-[var(--radius-card)] border-app border bg-surface-soft/40 p-2 transition duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-surface-soft/55"
                    >
                      <div className="relative h-52 overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface/40">
                        {primaryPrinting?.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={primaryPrinting.image_url}
                            alt={row.canonical.canonical_name}
                            className="h-full w-full object-cover object-top transition duration-200 group-hover:scale-[1.02]"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_65%)] p-4">
                            <div className="rounded-[var(--radius-input)] border-app border bg-surface/45 px-3 py-2 text-center">
                              <p className="text-app text-xs font-semibold">Image pending</p>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 min-w-0">
                        <p className="text-app truncate text-sm font-semibold">{row.canonical.canonical_name}</p>
                        <p className="text-muted mt-1 truncate text-xs">{rowSubtitle(row.canonical)}</p>
                        {chips.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {chips.map((chip) => (
                              <span key={`${row.canonical.slug}-${chip}`} className="border-app rounded-full border px-2 py-0.5 text-[11px] text-muted">
                                {chip}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
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

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Deck Matches</p>
          {deckRows.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No deck matches.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[color:var(--color-border)]">
              {deckRows.map((deck) => (
                <li key={deck.id}>
                  <Link href={`/d/${encodeURIComponent(deck.id)}`} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-app truncate text-sm font-semibold">{deck.name}</p>
                      <p className="text-muted truncate text-xs">{deck.format ?? "Format unknown"}</p>
                    </div>
                    <span className="text-muted text-xs font-semibold">View</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border bg-surface-soft/20 p-[var(--space-panel)]">
          <p className="text-muted text-sm font-semibold uppercase tracking-[0.12em]">Source DB Matches (debug)</p>
          {cardRows.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No direct source-card matches.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[color:var(--color-border)]">
              {cardRows.map((card) => (
                <li key={card.id}>
                  <Link href={`/c/${encodeURIComponent(card.slug)}`} className="flex items-center justify-between gap-3 py-3">
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
      </div>
    </main>
  );
}
