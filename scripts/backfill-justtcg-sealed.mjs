import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

function resolveBaseUrl() {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return "http://localhost:3000";
}

async function callJson(url, cronSecret) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function normalizeName(value) {
  return String(value ?? "")
    .replace(/^[A-Za-z]{1,5}\d*[A-Za-z]*\s*:\s*/u, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifySealedProduct(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  if (normalized.includes("elite trainer box") || /\betb\b/.test(normalized)) return "etb";
  if (normalized.includes("booster box")) return "booster_box";
  return null;
}

function summarizeRuns(runs) {
  return runs.reduce(
    (acc, run) => {
      acc.runs += 1;
      acc.setsProcessed += Number(run.setsProcessed ?? 0);
      acc.itemsFetched += Number(run.itemsFetched ?? 0);
      acc.itemsUpserted += Number(run.itemsUpserted ?? 0);
      acc.historyPointsWritten += Number(run.historyPointsWritten ?? 0);
      acc.variantMetricsWritten += Number(run.variantMetricsWritten ?? 0);
      return acc;
    },
    {
      runs: 0,
      setsProcessed: 0,
      itemsFetched: 0,
      itemsUpserted: 0,
      historyPointsWritten: 0,
      variantMetricsWritten: 0,
    },
  );
}

async function loadCoverageAudit(supabase) {
  const { data: setRows, error: setError } = await supabase
    .from("canonical_cards")
    .select("set_name")
    .not("set_name", "is", null)
    .not("slug", "like", "sealed:%")
    .limit(50000);

  if (setError) throw new Error(`canonical_cards sets: ${setError.message}`);

  const distinctSets = [...new Set((setRows ?? []).map((row) => row.set_name).filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );

  const { data: sealedRows, error: sealedError } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name")
    .like("slug", "sealed:%")
    .not("set_name", "is", null)
    .limit(50000);

  if (sealedError) throw new Error(`sealed canonical_cards: ${sealedError.message}`);

  const sealedSlugs = (sealedRows ?? []).map((row) => row.slug);
  const priceMap = new Map();
  const snapshotMap = new Map();

  if (sealedSlugs.length > 0) {
    const { data: metricRows, error: metricError } = await supabase
      .from("public_card_metrics")
      .select("canonical_slug, market_price, change_pct_24h, change_pct_7d, active_listings_7d")
      .in("canonical_slug", sealedSlugs)
      .is("printing_id", null)
      .eq("grade", "RAW");

    if (metricError) throw new Error(`public_card_metrics: ${metricError.message}`);

    for (const row of metricRows ?? []) {
      if (!priceMap.has(row.canonical_slug)) {
        priceMap.set(row.canonical_slug, row);
      }
    }

    const { data: snapshotRows, error: snapshotError } = await supabase
      .from("price_snapshots")
      .select("canonical_slug, price_value, observed_at")
      .in("canonical_slug", sealedSlugs)
      .eq("provider", "JUSTTCG")
      .eq("grade", "RAW");

    if (snapshotError) throw new Error(`price_snapshots: ${snapshotError.message}`);

    for (const row of snapshotRows ?? []) {
      if (!snapshotMap.has(row.canonical_slug)) {
        snapshotMap.set(row.canonical_slug, row);
      }
    }
  }

  const productsBySet = new Map();
  for (const row of sealedRows ?? []) {
    const setName = row.set_name;
    const productType = classifySealedProduct(row.canonical_name);
    if (!setName || !productType) continue;

    const priced = priceMap.get(row.slug);
    const snapshot = snapshotMap.get(row.slug);
    const normalizedSetName = normalizeName(setName);
    const current = productsBySet.get(normalizedSetName) ?? { booster_box: [], etb: [] };
    current[productType].push({
      slug: row.slug,
      name: row.canonical_name,
      market_price: priced?.market_price ?? snapshot?.price_value ?? null,
      change_pct_24h: priced?.change_pct_24h ?? null,
      change_pct_7d: priced?.change_pct_7d ?? null,
      active_listings_7d: priced?.active_listings_7d ?? null,
      set_name: row.set_name,
      price_source: priced?.market_price != null ? "card_metrics" : snapshot?.price_value != null ? "price_snapshots" : null,
    });
    productsBySet.set(normalizedSetName, current);
  }

  const missing = [];
  const covered = [];

  for (const setName of distinctSets) {
    const products = productsBySet.get(normalizeName(setName)) ?? { booster_box: [], etb: [] };
    const pricedBooster = products.booster_box.filter((row) => row.market_price != null);
    const pricedEtb = products.etb.filter((row) => row.market_price != null);

    if (pricedBooster.length === 0 || pricedEtb.length === 0) {
      missing.push({
        set_name: setName,
        booster_box_priced: pricedBooster.length,
        etb_priced: pricedEtb.length,
        booster_box_candidates: products.booster_box.length,
        etb_candidates: products.etb.length,
      });
      continue;
    }

    covered.push({
      set_name: setName,
      booster_box: pricedBooster[0],
      etb: pricedEtb[0],
    });
  }

  return {
    covered,
    missing,
    totalSets: distinctSets.length,
    setsWithBoth: covered.length,
  };
}

async function main() {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!cronSecret) throw new Error("CRON_SECRET is required.");
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

  const args = new Set(process.argv.slice(2));
  const baseUrl = resolveBaseUrl();
  const dryRun = args.has("--dry-run");
  const maxRunsArg = [...args].find((arg) => arg.startsWith("--max-runs="));
  const maxRuns = maxRunsArg ? Math.max(1, Number(maxRunsArg.split("=", 2)[1])) : 10;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const runs = [];

  if (!dryRun) {
    for (let run = 1; run <= maxRuns; run += 1) {
      const params = new URLSearchParams({
        asset: "sealed",
        force: "1",
      });
      const payload = await callJson(`${baseUrl}/api/cron/sync-justtcg-prices?${params.toString()}`, cronSecret);
      runs.push({
        run,
        setsProcessed: payload.setsProcessed ?? 0,
        done: Boolean(payload.done),
        itemsFetched: payload.itemsFetched ?? 0,
        itemsUpserted: payload.itemsUpserted ?? 0,
        historyPointsWritten: payload.historyPointsWritten ?? 0,
        variantMetricsWritten: payload.variantMetricsWritten ?? 0,
        firstError: payload.firstError ?? null,
      });
      if (payload.done) break;
    }
  }

  const coverage = await loadCoverageAudit(supabase);

  console.log(
    JSON.stringify(
      {
        baseUrl,
        dryRun,
        runSummary: summarizeRuns(runs),
        runs,
        coverage,
        missingPreview: coverage.missing.slice(0, 50),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
