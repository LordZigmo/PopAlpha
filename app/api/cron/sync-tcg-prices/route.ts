/**
 * Cron: sync-tcg-prices
 *
 * Runs daily (vercel.json: "0 5 * * *") and pages through every set in
 * card_printings, fetches TCGPlayer market prices for each set, then writes
 * one listing_observation per matched printing into listing_observations with
 * source='TCGPLAYER'. The market_snapshot_rollups view includes TCGPLAYER
 * observations alongside EBAY, so every card shows a price immediately instead
 * of "Collecting".
 *
 * Cursor strategy: stores the last processed set_code in ingest_runs.meta.
 * Each run processes SETS_PER_RUN sets alphabetically after the cursor.
 * When the catalog is exhausted (fewer sets found than requested) the cursor
 * resets to '' so the next run restarts from the beginning, giving a rolling
 * daily refresh of all prices.
 *
 * Volume: ~150 English sets × ~100 cards × ~2 printings avg ≈ 30,000 rows.
 * At 10 sets/run that's ~15 daily runs to cover the full catalog once, then
 * it keeps cycling, updating prices every ~15 days per set.
 *
 * Each observation uses external_id='tcgplayer-{productId}-{printingId}' so
 * upserts on (source, external_id) update the price and observed_at in place,
 * keeping the table compact regardless of how many times the cron runs.
 */

import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { resolveTcgTrackingSetDetailed, getCachedTcgSetPricing } from "@/lib/tcgtracking";

export const runtime = "nodejs";

/** Stay within Vercel Hobby 60 s limit. Raise to 300 on Pro. */
export const maxDuration = 60;

const SETS_PER_RUN = 10;
const JOB = "tcg_price_sync";

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string;
  finish: string;
};

type ObservationRow = {
  source: string;
  external_id: string;
  canonical_slug: string;
  printing_id: string;
  grade: string;
  title: string;
  price_value: number;
  currency: string;
  url: null;
  raw: Record<string, unknown>;
  observed_at: string;
};

/** Normalize a card number the same way the canonical importer does. */
function normalizeCardNumber(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return slashMatch[1];
  return trimmed;
}

export async function GET(req: Request) {
  // Vercel sends CRON_SECRET as a Bearer token on cron invocations.
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization")?.trim() ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getServerSupabaseClient();

  // ── Cursor: which set_code to continue from ──────────────────────────────
  const { data: lastRun } = await supabase
    .from("ingest_runs")
    .select("meta")
    .eq("job", JOB)
    .eq("status", "finished")
    .eq("ok", true)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ meta: Record<string, unknown> | null }>();

  const lastMeta = lastRun?.meta ?? null;
  // nextSetCode from the previous run is where we continue from.
  const lastSetCode =
    typeof lastMeta?.nextSetCode === "string" ? lastMeta.nextSetCode : "";

  // ── Fetch next batch of set_codes after the cursor ───────────────────────
  // We fetch many rows but deduplicate to SETS_PER_RUN unique set_codes.
  // Limit is generous to ensure we find enough unique sets even when a single
  // set has hundreds of printings.
  const { data: printingRows } = await supabase
    .from("card_printings")
    .select("set_code, set_name")
    .eq("source", "pokemontcg")
    .eq("language", "EN")
    .not("set_code", "is", null)
    .gt("set_code", lastSetCode)
    .order("set_code")
    .limit(SETS_PER_RUN * 500);

  // Deduplicate to first SETS_PER_RUN unique set_codes.
  const seenCodes = new Set<string>();
  const setsToProcess: Array<{ setCode: string; setName: string | null }> = [];
  for (const row of printingRows ?? []) {
    if (!row.set_code) continue;
    if (!seenCodes.has(row.set_code)) {
      seenCodes.add(row.set_code);
      setsToProcess.push({ setCode: row.set_code, setName: row.set_name ?? null });
      if (setsToProcess.length >= SETS_PER_RUN) break;
    }
  }

  // If we found fewer sets than requested, we've exhausted the catalog.
  // Reset the cursor so the next run starts from the beginning.
  const done = setsToProcess.length < SETS_PER_RUN;
  const lastProcessedSetCode = setsToProcess.at(-1)?.setCode ?? "";
  const nextSetCode = done ? "" : lastProcessedSetCode;

  // ── Create ingest run record ─────────────────────────────────────────────
  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "tcgplayer",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: { lastSetCode, nextSetCode, setsCount: setsToProcess.length, done },
    })
    .select("id")
    .single<{ id: string }>();

  const runId = runRow?.id ?? null;
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;

  // ── Process each set ─────────────────────────────────────────────────────
  for (const { setCode, setName } of setsToProcess) {
    try {
      // 1. Resolve the TCGTracker set that corresponds to this PokémonTCG set.
      const setResolution = await resolveTcgTrackingSetDetailed({
        cat: 3, // English
        setCode,
        setName,
      });

      if (!setResolution.chosen) continue;

      // 2. Fetch all priced items in the set (up to 250).
      const pricingPayload = await getCachedTcgSetPricing({
        cat: 3,
        setId: setResolution.chosen.id,
        limit: 250,
      });

      itemsFetched += pricingPayload.items.length;

      // 3. Fetch all printings for this set_code from our DB so we can map
      //    TCGPlayer card numbers → our printing IDs.
      const { data: printingsInSet } = await supabase
        .from("card_printings")
        .select("id, canonical_slug, card_number, finish")
        .eq("set_code", setCode)
        .eq("language", "EN");

      const printings = (printingsInSet ?? []) as PrintingRow[];

      // Build lookup: normalized card_number → list of printings.
      const byNumber = new Map<string, PrintingRow[]>();
      for (const p of printings) {
        if (!p.card_number || !p.canonical_slug) continue;
        const norm = normalizeCardNumber(p.card_number);
        const bucket = byNumber.get(norm) ?? [];
        bucket.push(p);
        byNumber.set(norm, bucket);
      }

      // 4. For each TCGPlayer item, write one observation per matching printing.
      //    Using the same price for all printings of a card is reasonable —
      //    TCGPlayer products don't always distinguish finish variants, and this
      //    ensures the price shows up regardless of which printing the user selects.
      const rows: ObservationRow[] = [];
      const now = new Date().toISOString();

      for (const item of pricingPayload.items) {
        const price = item.marketPrice ?? item.lowPrice ?? null;
        if (!price || price <= 0) continue;

        const normNum = normalizeCardNumber(item.number ?? undefined);
        const matchingPrintings = byNumber.get(normNum) ?? [];
        if (matchingPrintings.length === 0) continue;

        for (const printing of matchingPrintings) {
          rows.push({
            source: "TCGPLAYER",
            // Unique per product × printing so upserts update price in place.
            external_id: `tcgplayer-${item.productId}-${printing.id}`,
            canonical_slug: printing.canonical_slug,
            printing_id: printing.id,
            grade: "RAW",
            title: item.name ?? "",
            price_value: price,
            currency: "USD",
            url: null,
            raw: {
              marketPrice: item.marketPrice ?? null,
              lowPrice: item.lowPrice ?? null,
              midPrice: item.midPrice ?? null,
              highPrice: item.highPrice ?? null,
              productId: item.productId,
              setCode,
              updatedAt: item.updatedAt ?? null,
            },
            observed_at: now,
          });
        }
      }

      // 5. Upsert in batches of 100 to stay within payload limits.
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error } = await supabase
          .from("listing_observations")
          .upsert(batch, { onConflict: "source,external_id" });
        if (error) {
          itemsFailed += batch.length;
        } else {
          itemsUpserted += batch.length;
        }
      }
    } catch {
      // One bad set doesn't abort the whole run.
      itemsFailed += 1;
    }
  }

  // ── Finalize ingest run ──────────────────────────────────────────────────
  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: true,
        items_fetched: itemsFetched,
        items_upserted: itemsUpserted,
        items_failed: itemsFailed,
        ended_at: new Date().toISOString(),
        meta: { lastSetCode, nextSetCode, setsCount: setsToProcess.length, done },
      })
      .eq("id", runId);
  }

  return NextResponse.json({
    ok: true,
    lastSetCode,
    nextSetCode,
    setsProcessed: setsToProcess.length,
    done,
    itemsFetched,
    itemsUpserted,
    itemsFailed,
  });
}
