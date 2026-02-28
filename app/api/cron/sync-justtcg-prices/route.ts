/**
 * Cron: sync-justtcg-prices
 *
 * Runs daily at 7am UTC. Fetches Near Mint Pokemon card prices from JustTCG
 * and writes them to listing_observations as grade='RAW', source='JUSTTCG'.
 * The market_snapshot_rollups view aggregates JUSTTCG alongside EBAY and
 * TCGPLAYER, so every matched card immediately shows a price.
 *
 * JustTCG Free Tier: 1000 monthly / 100 daily / 10 per minute.
 * We process SETS_PER_RUN JustTCG sets per run, using 1 call for the /sets
 * listing plus ~1–2 calls per set for paginated /cards. With 20 sets/run
 * that's ~21–41 calls — safely within the daily 100-request cap.
 *
 * Cursor strategy: the last processed JustTCG set ID is stored in
 * ingest_runs.meta.nextSetId. Sets are processed alphabetically by ID.
 * When the full catalog is exhausted the cursor resets to '' so the next
 * run restarts from the beginning, giving a rolling daily price refresh.
 *
 * Set matching: JustTCG names ("SV01: Scarlet & Violet Base Set") are fuzzy-
 * matched against our card_printings.set_name values. Any set that scores
 * below 60/100 is skipped for that run.
 *
 * external_id='justtcg-{variantId}' so upserts update the price and
 * observed_at in place, keeping listing_observations compact.
 */

import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchJustTcgSets,
  fetchJustTcgCards,
  bestSetMatch,
  mapJustTcgPrinting,
  normalizeCardNumber,
} from "@/lib/justtcg";

export const runtime = "nodejs";
export const maxDuration = 300;

const SETS_PER_RUN = 20;
const JOB = "justtcg_price_sync";

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
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

  // ── Cursor: last processed JustTCG set ID ──────────────────────────────────
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
  const lastSetId =
    typeof lastMeta?.nextSetId === "string" ? lastMeta.nextSetId : "";

  // ── Fetch all JustTCG sets (one API call) ───────────────────────────────────
  const allJustTcgSets = await fetchJustTcgSets();
  allJustTcgSets.sort((a, b) => a.id.localeCompare(b.id));

  // Apply cursor: only process sets whose ID comes after the cursor.
  const remaining = lastSetId
    ? allJustTcgSets.filter((s) => s.id > lastSetId)
    : allJustTcgSets;

  const setsToProcess = remaining.slice(0, SETS_PER_RUN);
  const done = setsToProcess.length < SETS_PER_RUN;
  const lastProcessedSetId = setsToProcess.at(-1)?.id ?? "";
  const nextSetId = done ? "" : lastProcessedSetId;

  // ── Fetch all our set codes for fuzzy matching (done once per run) ──────────
  const { data: ourSetsRaw } = await supabase
    .from("card_printings")
    .select("set_code, set_name")
    .eq("language", "EN")
    .not("set_code", "is", null)
    .not("set_name", "is", null)
    .limit(10000);

  const seenSetCodes = new Set<string>();
  const ourSetCandidates: Array<{ setCode: string; setName: string }> = [];
  for (const row of ourSetsRaw ?? []) {
    if (row.set_code && row.set_name && !seenSetCodes.has(row.set_code)) {
      seenSetCodes.add(row.set_code);
      ourSetCandidates.push({ setCode: row.set_code, setName: row.set_name });
    }
  }

  // ── Create ingest run record ────────────────────────────────────────────────
  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "justtcg",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: { lastSetId, nextSetId, setsCount: setsToProcess.length, done },
    })
    .select("id")
    .single<{ id: string }>();

  const runId = runRow?.id ?? null;
  let itemsFetched = 0;
  let itemsUpserted = 0;
  let itemsFailed = 0;
  let firstUpsertError: string | null = null;

  // ── Process each JustTCG set ────────────────────────────────────────────────
  for (const jtSet of setsToProcess) {
    try {
      // 1. Fuzzy-match JustTCG set name to one of our set_codes.
      const match = bestSetMatch(jtSet.name, ourSetCandidates);
      if (!match) continue;

      // 2. Fetch our card_printings for this set_code.
      const { data: printingsInSet } = await supabase
        .from("card_printings")
        .select("id, canonical_slug, card_number, finish")
        .eq("set_code", match.setCode)
        .eq("language", "EN")
        .not("canonical_slug", "is", null);

      const printings = (printingsInSet ?? []) as PrintingRow[];
      if (!printings.length) continue;

      // Build lookup: normalizedNumber → finish → PrintingRow
      // Also keep a number-only fallback (prefer NON_HOLO).
      const byNumberAndFinish = new Map<string, Map<string, PrintingRow>>();
      const byNumber = new Map<string, PrintingRow>();
      for (const p of printings) {
        if (!p.card_number || !p.canonical_slug) continue;
        const normNum = normalizeCardNumber(p.card_number);

        let finishMap = byNumberAndFinish.get(normNum);
        if (!finishMap) {
          finishMap = new Map();
          byNumberAndFinish.set(normNum, finishMap);
        }
        finishMap.set(p.finish, p);

        if (!byNumber.has(normNum) || p.finish === "NON_HOLO") {
          byNumber.set(normNum, p);
        }
      }

      // 3. Fetch cards from JustTCG for this set (1 page, up to 250 cards).
      const { cards } = await fetchJustTcgCards(jtSet.id, 1);
      itemsFetched += cards.length;

      // 4. Build observation rows from Near Mint variants.
      const rows: ObservationRow[] = [];
      const now = new Date().toISOString();

      for (const card of cards) {
        const normNum = normalizeCardNumber(card.number);

        for (const variant of card.variants ?? []) {
          // Only Near Mint — this is the standard ungraded market reference.
          if (!variant.condition?.toLowerCase().includes("near mint")) continue;
          if (!variant.price || variant.price <= 0) continue;

          const mappedFinish = mapJustTcgPrinting(variant.printing ?? "");
          const finishMap = byNumberAndFinish.get(normNum);

          // Prefer exact finish match; fall back to any printing for this number.
          const printing =
            finishMap?.get(mappedFinish) ?? byNumber.get(normNum) ?? null;
          if (!printing) continue;

          rows.push({
            source: "JUSTTCG",
            external_id: `justtcg-${variant.id}`,
            canonical_slug: printing.canonical_slug,
            printing_id: printing.id,
            grade: "RAW",
            title: `${card.name} - ${variant.printing} - Near Mint`,
            price_value: variant.price,
            currency: "USD",
            url: null,
            raw: {
              variantId: variant.id,
              cardId: card.id,
              setId: jtSet.id,
              condition: variant.condition,
              printing: variant.printing,
              lastUpdated: variant.lastUpdated ?? null,
              priceChange7d: variant.priceChange7d ?? null,
              priceChange30d: variant.priceChange30d ?? null,
            },
            observed_at: now,
          });
        }
      }

      // 5. Upsert in batches of 100.
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error } = await supabase
          .from("listing_observations")
          .upsert(batch, { onConflict: "source,external_id" });
        if (error) {
          firstUpsertError ??= error.message;
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

  // ── Finalize ingest run ─────────────────────────────────────────────────────
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
        meta: { lastSetId, nextSetId, setsCount: setsToProcess.length, done },
      })
      .eq("id", runId);
  }

  return NextResponse.json({
    ok: true,
    lastSetId,
    nextSetId,
    setsProcessed: setsToProcess.length,
    done,
    itemsFetched,
    itemsUpserted,
    itemsFailed,
    firstUpsertError,
  });
}
