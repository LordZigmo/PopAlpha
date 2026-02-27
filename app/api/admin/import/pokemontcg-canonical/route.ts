import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getRequiredEnv } from "@/lib/env";
import type { PokemonTcgCard, PokemonTcgSet } from "@/lib/pokemontcg/client";
import { measureAsync } from "@/lib/perf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IngestRunRow = {
  id: string;
};

type PokemonListPayload<T> = {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
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

type ParsedParams = {
  pageStart: number;
  maxPages: number;
  pageSize: number;
  setId: string | null;
  dryRun: boolean;
};

function parseIntWithBounds(
  value: string | null,
  defaults: { fallback: number; min: number; max: number }
): number {
  const { fallback, min, max } = defaults;
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function parseParams(req: Request): ParsedParams {
  const url = new URL(req.url);
  const isProd = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const defaultMaxPages = isProd ? 1 : 3;

  return {
    pageStart: parseIntWithBounds(url.searchParams.get("pageStart"), { fallback: 1, min: 1, max: 100000 }),
    maxPages: parseIntWithBounds(url.searchParams.get("maxPages"), { fallback: defaultMaxPages, min: 1, max: 5 }),
    pageSize: parseIntWithBounds(url.searchParams.get("pageSize"), { fallback: 250, min: 1, max: 250 }),
    setId: url.searchParams.get("setId")?.trim() || null,
    dryRun: parseBoolean(url.searchParams.get("dryRun")),
  };
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
    if (lower === "normal") return { variantKey, finish: "NON_HOLO", finishDetail: null, edition: "UNLIMITED" };
    if (lower === "holofoil") return { variantKey, finish: "HOLO", finishDetail: null, edition: "UNLIMITED" };
    if (lower === "reverseholofoil") return { variantKey, finish: "REVERSE_HOLO", finishDetail: null, edition: "UNLIMITED" };
    if (lower.includes("1stedition")) return { variantKey, finish: "HOLO", finishDetail: variantKey, edition: "FIRST_EDITION" };
    if (lower === "unknown") return { variantKey, finish: "UNKNOWN", finishDetail: null, edition: "UNKNOWN" };
    return { variantKey, finish: "ALT_HOLO", finishDetail: variantKey, edition: "UNKNOWN" };
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
    sourceId: `${card.id}:${variant.finish}:${variant.variantKey}`,
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

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const asNum = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(asNum) && asNum > 0) return Math.min(asNum * 1000, 20_000);
  return null;
}

async function fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
  const maxAttempts = 6;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.ok) return response;
    if (!isRetryable(response.status) || attempt >= maxAttempts) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`PokemonTCG API error ${response.status}: ${body}`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const backoff = Math.min(10_000, 800 * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 251);
    await sleep(retryAfterMs ?? backoff + jitter);
    return fetchWithRetry(url, options, attempt + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempt >= maxAttempts) {
      throw new Error(`PokemonTCG fetch failed after ${attempt} attempts: ${message}`);
    }
    const backoff = Math.min(10_000, 800 * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 251);
    await sleep(backoff + jitter);
    return fetchWithRetry(url, options, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPokemonTcgJson<T>(path: string, params: URLSearchParams, apiKey: string): Promise<T> {
  const base = "https://api.pokemontcg.io/v2";
  const url = `${base}${path}?${params.toString()}`;
  const response = await fetchWithRetry(url, {
    headers: {
      "X-Api-Key": apiKey,
    },
  });
  return (await response.json()) as T;
}

async function updateRun(
  runId: string,
  updates: Partial<Record<"status" | "ok" | "items_fetched" | "items_upserted" | "items_failed" | "error_text" | "meta" | "ended_at", unknown>>
) {
  const supabase = getServerSupabaseClient();
  await supabase.from("ingest_runs").update(updates).eq("id", runId);
}

export async function POST(req: Request) {
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  if (adminSecret) {
    const supplied = req.headers.get("x-admin-secret")?.trim() ?? "";
    if (!supplied || supplied !== adminSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let apiKey = "";
  try {
    apiKey = getRequiredEnv("POKEMONTCG_API_KEY");
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }

  const startedAt = Date.now();
  const params = parseParams(req);
  const envName = process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ? "production" : "development";

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
        pageStart: params.pageStart,
        maxPages: params.maxPages,
        pageSize: params.pageSize,
        setId: params.setId,
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
    const setsParams = new URLSearchParams();
    setsParams.set("select", "id,name,releaseDate");
    const setsPayload = await measureAsync("pokemontcg.sets.fetch", {}, () =>
      fetchPokemonTcgJson<PokemonListPayload<PokemonTcgSet>>("/sets", setsParams, apiKey)
    );
    const setYearMap = new Map<string, number | null>();
    for (const set of setsPayload.data ?? []) {
      setYearMap.set(set.id, parseYearFromReleaseDate(set.releaseDate));
    }

    for (let page = params.pageStart; page < params.pageStart + params.maxPages; page += 1) {
      const pageParams = new URLSearchParams();
      pageParams.set("page", String(page));
      pageParams.set("pageSize", String(params.pageSize));
      pageParams.set("select", "id,name,number,rarity,supertype,subtypes,types,set,images,tcgplayer");
      if (params.setId) {
        pageParams.set("q", `set.id:${params.setId}`);
      }

      const payload = await measureAsync("pokemontcg.cards.fetch", { page, pageSize: params.pageSize, setId: params.setId }, () =>
        fetchPokemonTcgJson<PokemonListPayload<PokemonTcgCard>>("/cards", pageParams, apiKey)
      );
      const cards = payload.data ?? [];
      pagesProcessed += 1;
      nextPageStart = page + 1;
      itemsFetched += cards.length;

      const preparedCards = cards.map((card) => toPreparedCard(card, setYearMap));
      if (params.dryRun) {
        const wouldUpsertCanonicals = preparedCards.length;
        const wouldUpsertPrintings = preparedCards.reduce((sum, row) => sum + row.printings.length, 0);
        const wouldUpsertAliases =
          preparedCards.reduce((sum, row) => sum + row.canonicalAliases.length, 0) +
          preparedCards.reduce((sum, row) => sum + row.printings.reduce((inner, p) => inner + p.aliases.length, 0), 0);
        itemsUpserted += wouldUpsertCanonicals + wouldUpsertPrintings + wouldUpsertAliases;
      } else {
        const canonicalRows = preparedCards.map((entry) => entry.canonical);
        const { error: canonicalError } = await supabase.from("canonical_cards").upsert(canonicalRows, { onConflict: "slug" });
        if (canonicalError) throw new Error(canonicalError.message);
        itemsUpserted += canonicalRows.length;

        for (const prepared of preparedCards) {
          const canonicalAliases = prepared.canonicalAliases.map((alias) => ({
            alias,
            canonical_slug: prepared.canonical.slug,
          }));
          if (canonicalAliases.length > 0) {
            const { error: canonicalAliasError } = await supabase.from("card_aliases").upsert(canonicalAliases, {
              onConflict: "alias,canonical_slug",
            });
            if (canonicalAliasError) {
              itemsFailed += 1;
            } else {
              itemsUpserted += canonicalAliases.length;
            }
          }

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
              itemsFailed += 1;
              continue;
            }
            itemsUpserted += 1;

            const printingAliases = printing.aliases.map((alias) => ({
              alias,
              printing_id: printingRow.id,
            }));
            if (printingAliases.length > 0) {
              const { error: aliasError } = await supabase.from("printing_aliases").upsert(printingAliases, { onConflict: "alias" });
              if (aliasError) {
                itemsFailed += 1;
              } else {
                itemsUpserted += printingAliases.length;
              }
            }
          }
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
          setId: params.setId,
          dryRun: params.dryRun,
          env: envName,
          pageLastProcessed: page,
        },
      });

      if (cards.length < params.pageSize) {
        done = true;
        break;
      }
      if (params.setId && page * params.pageSize >= payload.totalCount) {
        done = true;
        break;
      }
    }

    if (!params.dryRun) {
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
        await supabase.from("card_aliases").delete().eq("alias", "bubble mew").neq("canonical_slug", bubbleMewEnglish.slug);
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
        await supabase.from("card_aliases").delete().eq("alias", "bubble mew jp").neq("canonical_slug", bubbleMewJp.slug);
        await supabase.from("card_aliases").upsert([{ alias: "bubble mew jp", canonical_slug: bubbleMewJp.slug }], {
          onConflict: "alias,canonical_slug",
        });
      }
    }

    const elapsedMs = Date.now() - startedAt;
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
      elapsedMs,
      done,
      dryRun: params.dryRun,
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
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
        elapsedMs,
        done,
        error: message,
      },
      { status: 500 }
    );
  }
}
