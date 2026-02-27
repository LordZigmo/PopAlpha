import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { PokemonTcgClient, type PokemonTcgSet } from "@/lib/pokemontcg/client";
import { normalizeCard, type LabelRule } from "@/lib/pokemontcg/normalize";

export const runtime = "nodejs";

type ImportBody = {
  pageStart?: number;
  pageEnd?: number;
  maxPages?: number;
};

type IngestRunRow = {
  id: number;
  items_fetched: number;
  items_upserted: number;
  items_failed: number;
};

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int > 0 ? int : fallback;
}

function parseYearFromReleaseDate(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/^(\d{4})/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
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
      job: "pokemontcg_import_en",
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
    .select("id, items_fetched, items_upserted, items_failed")
    .single<IngestRunRow>();

  if (runError || !runRow) {
    return NextResponse.json({ ok: false, error: runError?.message ?? "Could not create ingest run." }, { status: 500 });
  }

  const runId = runRow.id;
  let fetchedCount = 0;
  let upsertedCards = 0;
  let upsertedVariants = 0;
  let failed = 0;

  try {
    const { data: rulesData } = await supabase
      .from("label_normalization_rules")
      .select("match_type, match_value, normalized_finish, finish_detail, normalized_edition, priority")
      .eq("source", "pokemontcg")
      .order("priority", { ascending: true });
    const rules = ((rulesData ?? []) as LabelRule[]).sort((a, b) => a.priority - b.priority);

    const client = new PokemonTcgClient();
    const sets = await client.fetchSets();
    const setYearMap = new Map<string, number>();
    for (const set of sets) {
      setYearMap.set(set.id, parseYearFromReleaseDate((set as PokemonTcgSet).releaseDate));
    }

    let page = pageStart;
    let pagesProcessed = 0;
    const pageSize = 250;
    let keepGoing = true;

    while (keepGoing) {
      if (pageEnd !== null && page > pageEnd) break;
      if (maxPages > 0 && pagesProcessed >= maxPages) break;

      const payload = await client.fetchCardsPage(page, pageSize);
      const cards = payload.data ?? [];
      if (cards.length === 0) break;

      const normalized = cards.map((card) => normalizeCard(card, setYearMap, rules));
      fetchedCount += cards.length;

      const cardRows = normalized.map((item) => item.cardRow);
      const mappingRows = normalized.map((item) => item.mappingRow);
      const variantRows = normalized.flatMap((item) => item.variantRows);

      const { error: cardsError } = await supabase.from("cards").upsert(cardRows, { onConflict: "id" });
      if (cardsError) throw new Error(cardsError.message);
      upsertedCards += cardRows.length;

      const { error: mappingsError } = await supabase
        .from("card_external_mappings")
        .upsert(mappingRows, { onConflict: "card_id,source,mapping_type" });
      if (mappingsError) throw new Error(mappingsError.message);

      const { error: variantsError } = await supabase
        .from("card_variants")
        .upsert(variantRows, { onConflict: "card_id,variant_key" });
      if (variantsError) throw new Error(variantsError.message);
      upsertedVariants += variantRows.length;

      pagesProcessed += 1;
      await updateRun(runId, {
        items_fetched: fetchedCount,
        items_upserted: upsertedCards + upsertedVariants,
        items_failed: failed,
        meta: {
          page_last_processed: page,
          pages_processed: pagesProcessed,
        },
      });

      if (cards.length < pageSize || fetchedCount >= payload.totalCount) {
        keepGoing = false;
      } else {
        page += 1;
      }
    }

    await updateRun(runId, {
      status: "completed",
      ok: true,
      items_fetched: fetchedCount,
      items_upserted: upsertedCards + upsertedVariants,
      items_failed: failed,
      ended_at: new Date().toISOString(),
      meta: {
        page_last_processed: page,
      },
    });

    return NextResponse.json({
      ok: true,
      run_id: runId,
      fetched: fetchedCount,
      upserted_cards: upsertedCards,
      upserted_variants: upsertedVariants,
      failed,
    });
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(runId, {
      status: "failed",
      ok: false,
      items_fetched: fetchedCount,
      items_upserted: upsertedCards + upsertedVariants,
      items_failed: failed,
      error_text: message,
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        run_id: runId,
        fetched: fetchedCount,
        upserted_cards: upsertedCards,
        upserted_variants: upsertedVariants,
        failed,
        error: message,
      },
      { status: 500 }
    );
  }
}

