import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { PokemonTcgClient, type PokemonTcgCard, type PokemonTcgSet } from "@/lib/pokemontcg/client";

export const runtime = "nodejs";

type ImportBody = {
  pageStart?: number;
  pageEnd?: number;
  maxPages?: number;
};

type IngestRunRow = {
  id: number;
};

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  variant: string | null;
};

type DerivedPrinting = {
  variantKey: string;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finishDetail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
};

type PreparedCard = {
  canonical: CanonicalRow;
  printings: Array<{
    sourceId: string;
    setName: string | null;
    setCode: string | null;
    year: number | null;
    cardNumber: string;
    rawNumber: string;
    language: string;
    finish: DerivedPrinting["finish"];
    finishDetail: string | null;
    edition: DerivedPrinting["edition"];
    rarity: string | null;
    imageUrl: string | null;
    aliases: string[];
  }>;
  canonicalAliases: string[];
};

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int > 0 ? int : fallback;
}

function parseYearFromReleaseDate(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 200);
}

function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCardNumber(rawNumber: string): string {
  const trimmed = rawNumber.trim();
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return slashMatch[1];
  const numberMatch = trimmed.match(/^#?\s*(\d+)/);
  if (numberMatch) return numberMatch[1];
  return trimmed;
}

function extractSubject(name: string): string {
  const prefixes = [
    /^team rocket's\s+/i,
    /^blaine's\s+/i,
    /^brock's\s+/i,
    /^misty's\s+/i,
    /^erika's\s+/i,
    /^giovanni's\s+/i,
    /^lt\.\s*surge's\s+/i,
    /^dark\s+/i,
    /^light\s+/i,
  ];
  let working = name.trim();
  for (const prefix of prefixes) {
    working = working.replace(prefix, "");
  }
  working = working
    .replace(/\s+(ex|gx|vmax|vstar|v|lv\.x)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!working) return name.trim();
  return working;
}

function derivePrintingVariants(card: PokemonTcgCard): DerivedPrinting[] {
  const prices = card.tcgplayer?.prices ?? {};
  const keys = Object.keys(prices);
  const variantKeys = keys.length > 0 ? keys : ["unknown"];

  return variantKeys.map((variantKey) => {
    const lower = variantKey.toLowerCase();
    if (lower === "normal") {
      return { variantKey, finish: "NON_HOLO", finishDetail: null, edition: "UNLIMITED" };
    }
    if (lower === "holofoil") {
      return { variantKey, finish: "HOLO", finishDetail: null, edition: "UNLIMITED" };
    }
    if (lower === "reverseholofoil") {
      return { variantKey, finish: "REVERSE_HOLO", finishDetail: null, edition: "UNLIMITED" };
    }
    if (lower.includes("1stedition")) {
      return {
        variantKey,
        finish: "HOLO",
        finishDetail: variantKey,
        edition: "FIRST_EDITION",
      };
    }
    if (lower === "unknown") {
      return { variantKey, finish: "UNKNOWN", finishDetail: null, edition: "UNKNOWN" };
    }
    return {
      variantKey,
      finish: "ALT_HOLO",
      finishDetail: variantKey,
      edition: "UNKNOWN",
    };
  });
}

function buildAliases(cardName: string, setName: string | null, parsedNumber: string, rawNumber: string): string[] {
  const raw = [
    `${cardName} ${parsedNumber}`,
    `${cardName} ${rawNumber}`,
    setName ? `${setName} ${cardName} ${parsedNumber}` : "",
    setName ? `${setName} ${parsedNumber}` : "",
  ];
  return Array.from(new Set(raw.map(normalizeAlias).filter((alias) => alias.length > 0)));
}

function toPreparedCard(card: PokemonTcgCard, setYearMap: Map<string, number | null>): PreparedCard {
  const rawNumber = card.number?.trim() ?? "";
  const parsedNumber = parseCardNumber(rawNumber);
  const setName = card.set?.name?.trim() ?? null;
  const setCode = card.set?.id?.trim() ?? null;
  const year = setYearMap.get(card.set?.id ?? "") ?? parseYearFromReleaseDate(card.set?.releaseDate) ?? null;
  const imageUrl = card.images?.large ?? card.images?.small ?? null;
  const subject = extractSubject(card.name);
  const canonicalSlug = slugify(`${setName ?? "unknown-set"}-${parsedNumber}-${card.name}`) || slugify(card.id);
  const printingVariants = derivePrintingVariants(card);

  const printings = printingVariants.map((variant) => ({
    sourceId: `${card.id}:${variant.variantKey}`,
    setName,
    setCode,
    year,
    cardNumber: parsedNumber,
    rawNumber,
    language: "EN",
    finish: variant.finish,
    finishDetail: variant.finishDetail ?? (rawNumber !== parsedNumber ? `No. ${rawNumber}` : null),
    edition: variant.edition,
    rarity: card.rarity ?? null,
    imageUrl,
    aliases: buildAliases(card.name, setName, parsedNumber, rawNumber),
  }));

  return {
    canonical: {
      slug: canonicalSlug,
      canonical_name: card.name,
      subject,
      set_name: setName,
      year,
      card_number: parsedNumber || null,
      language: "EN",
      variant: "POKEMONTCG",
    },
    printings,
    canonicalAliases: Array.from(
      new Set(
        [
          normalizeAlias(card.name),
          setName ? normalizeAlias(`${setName} ${card.name}`) : "",
          parsedNumber ? normalizeAlias(`${card.name} ${parsedNumber}`) : "",
        ].filter((entry) => entry.length > 0)
      )
    ),
  };
}

async function updateRun(
  runId: number,
  updates: Partial<Record<"status" | "ok" | "items_fetched" | "items_upserted" | "items_failed" | "error_text" | "meta" | "ended_at", unknown>>
) {
  const supabase = getServerSupabaseClient();
  await supabase.from("ingest_runs").update(updates).eq("id", runId);
}

export async function POST(req: Request) {
  const importToken = process.env.ADMIN_IMPORT_TOKEN?.trim();
  if (importToken) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${importToken}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: ImportBody = {};
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    body = {};
  }

  const pageStart = toPositiveInt(body.pageStart, 1);
  const pageEnd = body.pageEnd ? toPositiveInt(body.pageEnd, pageStart) : null;
  const maxPages = body.maxPages ? toPositiveInt(body.maxPages, 0) : 0;

  const supabase = getServerSupabaseClient();
  const { data: runRow, error: runError } = await supabase
    .from("ingest_runs")
    .insert({
      source: "pokemontcg",
      job: "pokemontcg_canonical_import",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        page_start: pageStart,
        page_end: pageEnd,
        max_pages: maxPages,
      },
    })
    .select("id")
    .single<IngestRunRow>();

  if (runError || !runRow) {
    return NextResponse.json({ ok: false, error: runError?.message ?? "Could not create ingest run." }, { status: 500 });
  }

  const runId = runRow.id;
  let fetchedCount = 0;
  let upsertedCanonicals = 0;
  let upsertedPrintings = 0;
  let aliasUpserts = 0;
  let failed = 0;

  try {
    const client = new PokemonTcgClient();
    const sets = await client.fetchSets();
    const setYearMap = new Map<string, number | null>();
    for (const set of sets) {
      const row = set as PokemonTcgSet;
      setYearMap.set(row.id, parseYearFromReleaseDate(row.releaseDate));
    }

    let page = pageStart;
    let pagesProcessed = 0;
    const pageSize = 250;

    while (true) {
      if (pageEnd !== null && page > pageEnd) break;
      if (maxPages > 0 && pagesProcessed >= maxPages) break;

      const payload = await client.fetchCardsPage(page, pageSize);
      const cards = payload.data ?? [];
      if (cards.length === 0) break;
      fetchedCount += cards.length;

      const preparedCards = cards.map((card) => toPreparedCard(card, setYearMap));
      const canonicalRows = preparedCards.map((entry) => entry.canonical);
      const { error: canonicalError } = await supabase.from("canonical_cards").upsert(canonicalRows, { onConflict: "slug" });
      if (canonicalError) throw new Error(canonicalError.message);
      upsertedCanonicals += canonicalRows.length;

      for (const prepared of preparedCards) {
        for (const printing of prepared.printings) {
          const { data: printingRow, error: printingError } = await supabase
            .from("card_printings")
            .upsert(
              {
                canonical_slug: prepared.canonical.slug,
                set_name: printing.setName,
                set_code: printing.setCode,
                year: printing.year,
                card_number: printing.cardNumber,
                language: printing.language,
                finish: printing.finish,
                finish_detail: printing.finishDetail,
                edition: printing.edition,
                stamp: null,
                rarity: printing.rarity,
                image_url: printing.imageUrl,
                source: "pokemontcg",
                source_id: printing.sourceId,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "source,source_id" }
            )
            .select("id")
            .single<{ id: string }>();

          if (printingError || !printingRow) {
            failed += 1;
            continue;
          }
          upsertedPrintings += 1;

          const printingAliases = printing.aliases.map((alias) => ({
            alias,
            printing_id: printingRow.id,
          }));
          if (printingAliases.length > 0) {
            const { error: aliasError } = await supabase.from("printing_aliases").upsert(printingAliases, { onConflict: "alias" });
            if (aliasError) {
              failed += 1;
            } else {
              aliasUpserts += printingAliases.length;
            }
          }
        }

        const canonicalAliases = prepared.canonicalAliases.map((alias) => ({
          alias,
          canonical_slug: prepared.canonical.slug,
        }));
        if (canonicalAliases.length > 0) {
          const { error: canonicalAliasError } = await supabase
            .from("card_aliases")
            .upsert(canonicalAliases, { onConflict: "alias,canonical_slug" });
          if (canonicalAliasError) failed += 1;
        }
      }

      pagesProcessed += 1;
      await updateRun(runId, {
        items_fetched: fetchedCount,
        items_upserted: upsertedCanonicals + upsertedPrintings + aliasUpserts,
        items_failed: failed,
        meta: {
          page_last_processed: page,
          pages_processed: pagesProcessed,
        },
      });

      if (cards.length < pageSize || fetchedCount >= payload.totalCount) break;
      page += 1;
    }

    const { data: bubbleMewEnglish } = await supabase
      .from("canonical_cards")
      .select("slug")
      .eq("card_number", "232")
      .ilike("canonical_name", "%mew ex%")
      .ilike("set_name", "%paldean fates%")
      .eq("language", "EN")
      .limit(1)
      .maybeSingle<{ slug: string }>();

    if (bubbleMewEnglish?.slug) {
      // "bubble mew" should always resolve to EN Paldean Fates #232.
      await supabase
        .from("card_aliases")
        .delete()
        .eq("alias", "bubble mew")
        .neq("canonical_slug", bubbleMewEnglish.slug);
      await supabase.from("card_aliases").upsert(
        [
          { alias: "bubble mew", canonical_slug: bubbleMewEnglish.slug },
          { alias: "paldean fates bubble mew", canonical_slug: bubbleMewEnglish.slug },
        ],
        { onConflict: "alias,canonical_slug" }
      );
    }

    const { data: bubbleMewJp } = await supabase
      .from("canonical_cards")
      .select("slug")
      .eq("card_number", "205")
      .ilike("canonical_name", "%mew ex%")
      .or("set_name.ilike.%card 151%,set_name.ilike.%pokemon 151%")
      .in("language", ["JP", "JA"])
      .limit(1)
      .maybeSingle<{ slug: string }>();

    if (bubbleMewJp?.slug) {
      await supabase
        .from("card_aliases")
        .delete()
        .eq("alias", "bubble mew jp")
        .neq("canonical_slug", bubbleMewJp.slug);
      await supabase.from("card_aliases").upsert([{ alias: "bubble mew jp", canonical_slug: bubbleMewJp.slug }], {
        onConflict: "alias,canonical_slug",
      });
    }

    await updateRun(runId, {
      status: "completed",
      ok: true,
      items_fetched: fetchedCount,
      items_upserted: upsertedCanonicals + upsertedPrintings + aliasUpserts,
      items_failed: failed,
      ended_at: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      run_id: runId,
      fetched: fetchedCount,
      upserted_canonicals: upsertedCanonicals,
      upserted_printings: upsertedPrintings,
      aliases_upserted: aliasUpserts,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(runId, {
      status: "failed",
      ok: false,
      items_fetched: fetchedCount,
      items_upserted: upsertedCanonicals + upsertedPrintings + aliasUpserts,
      items_failed: failed + 1,
      error_text: message,
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        run_id: runId,
        fetched: fetchedCount,
        upserted_canonicals: upsertedCanonicals,
        upserted_printings: upsertedPrintings,
        aliases_upserted: aliasUpserts,
        failed: failed + 1,
        error: message,
      },
      { status: 500 }
    );
  }
}
