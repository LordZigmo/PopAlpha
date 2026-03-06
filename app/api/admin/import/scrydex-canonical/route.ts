import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  getScrydexCredentials,
  fetchExpansionsPage,
  fetchCardsPage,
  type ScrydexCard,
} from "@/lib/scrydex/client";
import { buildCanonicalSearchDoc, normalizeSearchText } from "@/lib/search/normalize.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IngestRunRow = { id: string };

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  variant: string | null;
  primary_image_url: string | null;
  search_doc: string;
  search_doc_norm: string;
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
    finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
    finishDetail: string | null;
    edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
    rarity: string | null;
    imageUrl: string | null;
    aliases: string[];
  }>;
  canonicalAliases: string[];
};

type ParsedParams = {
  pageStart: number;
  maxPages: number;
  pageSize: number;
  expansionId: string | null;
  dryRun: boolean;
};

function parseIntWithBounds(
  value: string | null,
  defaults: { fallback: number; min: number; max: number }
): number {
  if (!value) return defaults.fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaults.fallback;
  return Math.max(defaults.min, Math.min(defaults.max, parsed));
}

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function parseParams(req: Request): ParsedParams {
  const url = new URL(req.url);
  const isProd = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  return {
    pageStart: parseIntWithBounds(url.searchParams.get("pageStart"), { fallback: 1, min: 1, max: 100000 }),
    maxPages: parseIntWithBounds(url.searchParams.get("maxPages"), { fallback: isProd ? 1 : 3, min: 1, max: 10 }),
    pageSize: parseIntWithBounds(url.searchParams.get("pageSize"), { fallback: 100, min: 1, max: 100 }),
    expansionId: url.searchParams.get("expansionId")?.trim() || null,
    dryRun: parseBoolean(url.searchParams.get("dryRun")),
  };
}

function parseYearFromReleaseDate(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 200);
}

function parseCardNumber(rawNumber: string): string {
  const trimmed = rawNumber.trim();
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return slashMatch[1];
  const numberMatch = trimmed.match(/^#?\s*(\d+)/);
  return numberMatch ? numberMatch[1] : trimmed;
}

function extractSubject(name: string): string {
  const prefixes = [
    /^team rocket's\s+/i,
    /^brock's\s+/i,
    /^misty's\s+/i,
    /^erika's\s+/i,
    /^giovanni's\s+/i,
    /^dark\s+/i,
    /^light\s+/i,
  ];
  let working = name.trim();
  for (const prefix of prefixes) working = working.replace(prefix, "");
  working = working
    .replace(/\s+(ex|gx|vmax|vstar|v|lv\.x)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return working || name.trim();
}

function variantNameToFinish(variantName: string): {
  finish: PreparedCard["printings"][0]["finish"];
  edition: PreparedCard["printings"][0]["edition"];
} {
  const lower = variantName.toLowerCase().replace(/-/g, "");
  if (lower.includes("1stedition") || lower.includes("firstedition")) return { finish: "HOLO", edition: "FIRST_EDITION" };
  if (lower === "normal" || lower === "nonholo") return { finish: "NON_HOLO", edition: "UNLIMITED" };
  if (lower === "holofoil" || lower === "holo") return { finish: "HOLO", edition: "UNLIMITED" };
  if (lower.includes("reverse") || lower === "reverseholofoil") return { finish: "REVERSE_HOLO", edition: "UNLIMITED" };
  if (lower === "unknown") return { finish: "UNKNOWN", edition: "UNKNOWN" };
  return { finish: "ALT_HOLO", edition: "UNKNOWN" };
}

function buildAliases(
  cardName: string,
  setName: string | null,
  parsedNumber: string,
  rawNumber: string
): string[] {
  const raw = [
    `${cardName} ${parsedNumber}`,
    `${cardName} ${rawNumber}`,
    setName ? `${setName} ${cardName} ${parsedNumber}` : "",
    setName ? `${setName} ${parsedNumber}` : "",
  ];
  return Array.from(
    new Set(raw.map((s) => normalizeSearchText(s)).filter((alias) => alias.length > 0))
  );
}

function toPreparedCard(card: ScrydexCard, setYearMap: Map<string, number | null>): PreparedCard {
  const rawNumber = (card.number ?? card.printed_number ?? "").trim();
  const parsedNumber = parseCardNumber(rawNumber);
  const setName = card.expansion?.name?.trim() ?? null;
  const setCode = card.expansion?.id?.trim() ?? null;
  const year =
    setYearMap.get(card.expansion?.id ?? "") ??
    parseYearFromReleaseDate(card.expansion?.release_date ?? card.expansion?.releaseDate) ??
    null;
  const images = card.images ?? [];
  const firstImg = images[0];
  const imageUrl = firstImg && (firstImg.large ?? firstImg.medium ?? firstImg.small) ? (firstImg.large ?? firstImg.medium ?? firstImg.small) ?? null : null;
  const subject = extractSubject(card.name);
  const canonicalSlug =
    slugify(`${setName ?? "unknown-set"}-${parsedNumber}-${card.name}`) || slugify(card.id);

  const variants = card.variants && card.variants.length > 0 ? card.variants : [{ name: "unknown" }];
  const printings = variants.map((v) => {
    const { finish, edition } = variantNameToFinish(v.name);
    const variantKey = v.name;
    const sourceId = `${card.id}:${finish}:${variantKey}`;
    const finishDetail =
      edition !== "UNLIMITED"
        ? variantKey
        : rawNumber !== parsedNumber
          ? `No. ${rawNumber}`
          : variantKey;
    const variantImg = v.images?.[0];
    const variantImageUrl = variantImg && (variantImg.large ?? variantImg.medium ?? variantImg.small) ? (variantImg.large ?? variantImg.medium ?? variantImg.small) ?? null : null;
    return {
      sourceId,
      setName,
      setCode,
      year,
      cardNumber: parsedNumber,
      rawNumber,
      language: "EN",
      finish,
      finishDetail,
      edition,
      rarity: card.rarity ?? null,
      imageUrl: imageUrl ?? variantImageUrl,
      aliases: buildAliases(card.name, setName, parsedNumber, rawNumber),
    };
  });

  const searchDoc = buildCanonicalSearchDoc({
    canonical_name: card.name,
    subject,
    set_name: setName,
    card_number: parsedNumber || null,
    year,
  });

  return {
    canonical: {
      slug: canonicalSlug,
      canonical_name: card.name,
      subject,
      set_name: setName,
      year,
      card_number: parsedNumber || null,
      language: "EN",
      variant: "SCRYDEX",
      primary_image_url: imageUrl,
      search_doc: searchDoc,
      search_doc_norm: normalizeSearchText(searchDoc),
    },
    printings,
    canonicalAliases: Array.from(
      new Set(
        [
          normalizeSearchText(card.name),
          setName ? normalizeSearchText(`${setName} ${card.name}`) : "",
          parsedNumber ? normalizeSearchText(`${card.name} ${parsedNumber}`) : "",
        ].filter((entry) => entry.length > 0)
      )
    ),
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateRun(
  runId: string,
  updates: Partial<Record<"status" | "ok" | "items_fetched" | "items_upserted" | "items_failed" | "error_text" | "meta" | "ended_at", unknown>>
) {
  const supabase = dbAdmin();
  await supabase.from("ingest_runs").update(updates).eq("id", runId);
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let credentials: ReturnType<typeof getScrydexCredentials>;
  try {
    credentials = getScrydexCredentials();
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }

  console.log("[scrydex-import] SCRYDEX credentials present");

  const startedAt = Date.now();
  const params = parseParams(req);
  const envName = process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ? "production" : "development";
  const supabase = dbAdmin();

  const { data: runRow, error: runError } = await supabase
    .from("ingest_runs")
    .insert({
      source: "scrydex",
      job: "scrydex_canonical_import",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        pageStart: params.pageStart,
        maxPages: params.maxPages,
        pageSize: params.pageSize,
        expansionId: params.expansionId,
        dryRun: params.dryRun,
        env: envName,
      },
    })
    .select("id")
    .single<IngestRunRow>();

  if (runError || !runRow) {
    return NextResponse.json({ ok: false, error: runError?.message ?? "Could not create ingest run." }, { status: 500 });
  }

  const runId = runRow.id;
  let pagesProcessed = 0;
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let done = false;
  let nextPageStart = params.pageStart;

  try {
    const setYearMap = new Map<string, number | null>();
    let expPage = 1;
    const expPageSize = 100;
    while (true) {
      const res = await fetchExpansionsPage(expPage, expPageSize, credentials);
      const expansions = res.data ?? [];
      for (const exp of expansions) {
        setYearMap.set(exp.id, parseYearFromReleaseDate(exp.release_date ?? exp.releaseDate));
      }
      if (expansions.length < expPageSize) break;
      expPage += 1;
      await sleep(200);
    }

    for (let page = params.pageStart; page < params.pageStart + params.maxPages; page += 1) {
      if (page > params.pageStart) await sleep(200);
      const payload = await fetchCardsPage(
        page,
        params.pageSize,
        params.expansionId,
        credentials
      );
      const cards = payload.data ?? [];
      pagesProcessed += 1;
      nextPageStart = page + 1;
      itemsFetched += cards.length;

      const preparedCards = cards.map((card) => toPreparedCard(card, setYearMap));

      if (params.dryRun) {
        itemsUpserted +=
          preparedCards.length +
          preparedCards.reduce((s, r) => s + r.printings.length, 0) +
          preparedCards.reduce((s, r) => s + r.canonicalAliases.length, 0) +
          preparedCards.reduce((s, r) => s + r.printings.reduce((s2, p) => s2 + p.aliases.length, 0), 0);
      } else {
        const canonicalRows = preparedCards.map((p) => p.canonical);
        const { error: canonicalError } = await supabase
          .from("canonical_cards")
          .upsert(canonicalRows, { onConflict: "slug" });
        if (canonicalError) throw new Error(canonicalError.message);
        itemsUpserted += canonicalRows.length;

        const allCanonicalAliases = preparedCards.flatMap((p) =>
          p.canonicalAliases.map((alias) => ({
            alias,
            alias_norm: normalizeSearchText(alias),
            canonical_slug: p.canonical.slug,
          }))
        );
        if (allCanonicalAliases.length > 0) {
          const { error: e } = await supabase
            .from("card_aliases")
            .upsert(allCanonicalAliases, { onConflict: "alias,canonical_slug" });
          if (e) {
            console.error("[scrydex-canonical] card_aliases upsert error:", e.message, e.details);
            itemsFailed += allCanonicalAliases.length;
          } else itemsUpserted += allCanonicalAliases.length;
        }

        const allPrintingRows = preparedCards.flatMap((p) =>
          p.printings.map((pr) => ({
            canonical_slug: p.canonical.slug,
            set_name: pr.setName,
            set_code: pr.setCode,
            year: pr.year,
            card_number: pr.cardNumber,
            language: pr.language,
            finish: pr.finish,
            finish_detail: pr.finishDetail,
            edition: pr.edition,
            stamp: null,
            rarity: pr.rarity,
            image_url: pr.imageUrl,
            source: "scrydex",
            source_id: pr.sourceId,
            updated_at: new Date().toISOString(),
          }))
        );

        const BATCH = 100;
        const sourceIdToPrintingId = new Map<string, string>();
        for (let i = 0; i < allPrintingRows.length; i += BATCH) {
          const chunk = allPrintingRows.slice(i, i + BATCH);
          const { data: inserted, error: printingError } = await supabase
            .from("card_printings")
            .upsert(chunk, { onConflict: "source,source_id" })
            .select("id, source_id");
          if (printingError) {
            console.error("[scrydex-canonical] card_printings upsert error:", printingError.message, printingError.details);
            itemsFailed += chunk.length;
          } else {
            itemsUpserted += chunk.length;
            for (const row of inserted ?? []) sourceIdToPrintingId.set(row.source_id, row.id);
          }
        }

        const allPrintingAliases: { alias: string; printing_id: string }[] = [];
        const aliasSeen = new Set<string>();
        for (const p of preparedCards) {
          for (const pr of p.printings) {
            const printingId = sourceIdToPrintingId.get(pr.sourceId);
            if (!printingId) continue;
            for (const alias of pr.aliases) {
              if (aliasSeen.has(alias)) continue;
              aliasSeen.add(alias);
              allPrintingAliases.push({ alias, printing_id: printingId });
            }
          }
        }
        const ALIAS_BATCH = 400;
        for (let i = 0; i < allPrintingAliases.length; i += ALIAS_BATCH) {
          const chunk = allPrintingAliases.slice(i, i + ALIAS_BATCH);
          const { error: e } = await supabase.from("printing_aliases").upsert(chunk, { onConflict: "alias" });
          if (e) {
            console.error("[scrydex-canonical] printing_aliases upsert error:", e.message, e.details);
            itemsFailed += chunk.length;
          } else itemsUpserted += chunk.length;
        }
      }

      await updateRun(runId, {
        items_fetched: itemsFetched,
        items_upserted: itemsUpserted,
        items_failed: itemsFailed,
        meta: {
          pageStart: params.pageStart,
          maxPages: params.maxPages,
          pageSize: params.pageSize,
          expansionId: params.expansionId,
          dryRun: params.dryRun,
          env: envName,
          pageLastProcessed: page,
        },
      });

      if (cards.length < params.pageSize) {
        done = true;
        break;
      }
      if (payload.totalCount != null && page * params.pageSize >= payload.totalCount) {
        done = true;
        break;
      }
    }

    await updateRun(runId, {
      status: "finished",
      ok: true,
      items_fetched: itemsFetched,
      items_upserted: itemsUpserted,
      items_failed: itemsFailed,
      ended_at: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      run_id: runId,
      pagesProcessed,
      pageStart: params.pageStart,
      nextPageStart,
      itemsFetched,
      itemsUpserted,
      itemsFailed,
      elapsedMs: Date.now() - startedAt,
      done,
      dryRun: params.dryRun,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[scrydex-import] Error:", message);
    await updateRun(runId, {
      status: "failed",
      ok: false,
      items_fetched: itemsFetched,
      items_upserted: itemsUpserted,
      items_failed: itemsFailed + 1,
      error_text: message,
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        run_id: runId,
        pagesProcessed,
        pageStart: params.pageStart,
        nextPageStart,
        itemsFetched,
        itemsUpserted,
        itemsFailed: itemsFailed + 1,
        elapsedMs: Date.now() - startedAt,
        done,
        error: message,
      },
      { status: 500 }
    );
  }
}
