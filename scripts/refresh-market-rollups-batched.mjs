import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PAGE_SIZE = Number.parseInt(process.env.MARKET_REFRESH_PAGE_SIZE ?? "1000", 10);
const SET_BATCH_SIZE = Number.parseInt(process.env.MARKET_REFRESH_SET_BATCH_SIZE ?? "5", 10);
const CARD_BATCH_SIZE = Number.parseInt(process.env.MARKET_REFRESH_CARD_BATCH_SIZE ?? "400", 10);

function parseArgs(argv) {
  const out = {
    onlySets: null,
    limitSets: null,
  };

  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--onlySets=")) {
      out.onlySets = raw
        .slice("--onlySets=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (raw.startsWith("--limitSets=")) {
      const parsed = Number.parseInt(raw.slice("--limitSets=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) out.limitSets = parsed;
    }
  }

  return out;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function loadCanonicalCards() {
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug,set_name")
      .order("slug")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  return rows;
}

function buildSetGroups(rows) {
  const bySet = new Map();

  for (const row of rows) {
    const setName = String(row.set_name ?? "").trim();
    const slug = String(row.slug ?? "").trim();
    if (!setName || !slug) continue;

    let entry = bySet.get(setName);
    if (!entry) {
      entry = {
        setName,
        sampleSlug: slug,
        slugs: [],
      };
      bySet.set(setName, entry);
    }

    entry.slugs.push(slug);
  }

  return [...bySet.values()].sort((a, b) => a.setName.localeCompare(b.setName));
}

async function callRpc(name, params) {
  const { data, error } = await supabase.rpc(name, params ?? {});
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = await loadCanonicalCards();
  let groups = buildSetGroups(rows);

  if (args.onlySets?.length) {
    const allow = new Set(args.onlySets.map((value) => value.toLowerCase()));
    groups = groups.filter((group) => allow.has(group.setName.toLowerCase()));
  }

  if (args.limitSets) {
    groups = groups.slice(0, args.limitSets);
  }

  const setBatches = chunk(groups, SET_BATCH_SIZE);
  const summary = {
    ok: true,
    totalSets: groups.length,
    totalCards: groups.reduce((sum, group) => sum + group.slugs.length, 0),
    batches: [],
  };

  for (let index = 0; index < setBatches.length; index += 1) {
    const batch = setBatches[index];
    const setNames = batch.map((group) => group.setName);
    const sampleKeys = batch.map((group) => ({ canonical_slug: group.sampleSlug }));
    const canonicalSlugs = batch.flatMap((group) => group.slugs);

    const cardMetrics = await callRpc("refresh_card_metrics_for_variants", { keys: sampleKeys });

    const priceChanges = [];
    const parity = [];
    const marketConfidence = [];
    for (const slugChunk of chunk(canonicalSlugs, CARD_BATCH_SIZE)) {
      priceChanges.push(await callRpc("refresh_price_changes_for_cards", { p_canonical_slugs: slugChunk }));

      try {
        parity.push(await callRpc("refresh_canonical_raw_provider_parity_for_cards", {
          p_canonical_slugs: slugChunk,
          p_window_days: 30,
        }));
      } catch (error) {
        parity.push({ skipped: true, error: error instanceof Error ? error.message : String(error) });
      }

      marketConfidence.push(await callRpc("refresh_card_market_confidence_for_cards", {
        p_canonical_slugs: slugChunk,
      }));
    }

    const batchResult = {
      batch: index + 1,
      setNames,
      setCount: batch.length,
      cardCount: canonicalSlugs.length,
      cardMetrics,
      priceChanges,
      parity,
      marketConfidence,
    };
    summary.batches.push(batchResult);
    console.log(JSON.stringify(batchResult));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
