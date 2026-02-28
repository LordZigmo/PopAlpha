/**
 * Cron: sync-justtcg-prices
 *
 * Runs daily at 7am UTC. Fetches Near Mint Pokemon card prices from JustTCG
 * and writes them to price_snapshots (via provider_ingests for audit).
 * Calls refresh_card_metrics() at the end so card_metrics is immediately
 * up to date.
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
 * provider_ref='justtcg-{variantId}' so upserts update the price and
 * observed_at in place, keeping price_snapshots compact.
 */

import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchJustTcgSets,
  fetchJustTcgCards,
  bestSetMatch,
  mapJustTcgPrinting,
  normalizeCardNumber,
} from "@/lib/providers/justtcg";

export const runtime = "nodejs";
export const maxDuration = 300;

const SETS_PER_RUN = 20;
const JOB = "justtcg_price_sync";
const PROVIDER = "JUSTTCG";

type PrintingRow = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
  finish: string;
};

type IngestRow = {
  provider: string;
  job: string;
  set_id: string;
  card_id: string;
  variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  raw_payload: Record<string, unknown>;
};

type SnapshotRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  price_value: number;
  currency: string;
  provider: string;
  provider_ref: string;
  ingest_id: string | null;
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

      const now = new Date().toISOString();
      const ingests: IngestRow[] = [];
      const snapshots: SnapshotRow[] = [];

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

          // Build ingest audit row (even if no printing match — slug will be null).
          ingests.push({
            provider: PROVIDER,
            job: JOB,
            set_id: jtSet.id,
            card_id: card.id,
            variant_id: variant.id,
            canonical_slug: printing?.canonical_slug ?? null,
            printing_id: printing?.id ?? null,
            raw_payload: {
              variantId: variant.id,
              cardId: card.id,
              setId: jtSet.id,
              setName: jtSet.name,
              cardName: card.name,
              cardNumber: card.number,
              condition: variant.condition,
              printing: variant.printing,
              price: variant.price,
              lastUpdated: variant.lastUpdated ?? null,
              priceChange7d: variant.priceChange7d ?? null,
              priceChange30d: variant.priceChange30d ?? null,
            },
          });

          if (!printing) continue;

          snapshots.push({
            canonical_slug: printing.canonical_slug,
            printing_id: printing.id,
            grade: "RAW",
            price_value: variant.price,
            currency: "USD",
            provider: PROVIDER,
            provider_ref: `justtcg-${variant.id}`,
            ingest_id: null, // filled in after ingest batch insert
            observed_at: now,
          });
        }
      }

      // 4a. Insert provider_ingests in batches of 100.
      //     We don't need the IDs back for ingest_id linkage (acceptable tradeoff
      //     for batch efficiency — the audit row exists regardless).
      for (let i = 0; i < ingests.length; i += 100) {
        const batch = ingests.slice(i, i + 100);
        await supabase.from("provider_ingests").insert(batch);
      }

      // 4b. Upsert price_snapshots in batches of 100.
      for (let i = 0; i < snapshots.length; i += 100) {
        const batch = snapshots.slice(i, i + 100);
        const { error } = await supabase
          .from("price_snapshots")
          .upsert(batch, { onConflict: "provider,provider_ref" });
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

  // ── Refresh card_metrics so prices are immediately visible ─────────────────
  let metricsResult: Record<string, unknown> | null = null;
  try {
    const { data } = await supabase.rpc("refresh_card_metrics");
    metricsResult = data as Record<string, unknown> | null;
  } catch {
    // Non-fatal: metrics will be stale until next run.
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
    metricsResult,
  });
}
