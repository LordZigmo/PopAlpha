import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const DAILY_LIMIT = 50000;
const MONTHLY_LIMIT = 500000;
const STATE_PATH = path.join(process.cwd(), "scripts", "justtcg-live-state.json");
const ICONIC_SET_BOOSTS = {
  "base": 3000,
  "base set": 3000,
  "jungle": 2400,
  "fossil": 2400,
  "team rocket": 2200,
  "gym heroes": 2200,
  "gym challenge": 2200,
  "neo genesis": 2200,
  "legendary collection": 2000,
  "expedition": 2000,
  "aquapolis": 2000,
  "skyridge": 2000,
  "hidden fates": 1800,
  "shining fates": 1600,
  "pokemon 151": 1800,
  "151": 1800,
  "xy evolutions": 1600,
  "evolutions": 1600,
};

function resolveBaseUrl() {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod}`;

  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) return `https://${deployment}`;

  return "http://localhost:3000";
}

function normalizeSetName(name) {
  return name
    .toLowerCase()
    .replace(/^[a-z]{1,4}\d*[a-z]*\s*:\s*/u, "")
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setNameToJustTcgId(setName) {
  return (
    setName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-pokemon"
  );
}

function currentDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      dayKey: currentDayKey(),
      monthKey: currentMonthKey(),
      requestsToday: 0,
      requestsMonth: 0,
      processedSetIds: [],
      completedAt: null,
      lastRun: null,
    };
  }

  const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const dayKey = currentDayKey();
  const monthKey = currentMonthKey();

  return {
    dayKey,
    monthKey,
    requestsToday: raw.dayKey === dayKey ? Number(raw.requestsToday ?? 0) : 0,
    requestsMonth: raw.monthKey === monthKey ? Number(raw.requestsMonth ?? 0) : 0,
    processedSetIds: raw.monthKey === monthKey && Array.isArray(raw.processedSetIds) ? raw.processedSetIds : [],
    completedAt: raw.completedAt ?? null,
    lastRun: raw.lastRun ?? null,
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function buildPopularityScore(setName, cardCount) {
  const normalized = normalizeSetName(setName);
  let boost = 0;

  for (const [token, value] of Object.entries(ICONIC_SET_BOOSTS)) {
    if (normalized === token || normalized.includes(token)) {
      boost = Math.max(boost, value);
    }
  }

  return cardCount + boost;
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

async function loadRankedSets(supabase) {
  const { data: printings, error: printingsError } = await supabase
    .from("card_printings")
    .select("set_code, set_name, canonical_slug")
    .eq("language", "EN")
    .not("set_code", "is", null)
    .not("set_name", "is", null)
    .not("canonical_slug", "is", null)
    .limit(50000);

  if (printingsError) {
    throw new Error(`card_printings: ${printingsError.message}`);
  }

  const { data: providerMapRows, error: mapError } = await supabase
    .from("provider_set_map")
    .select("canonical_set_code, provider_set_id, confidence")
    .eq("provider", "JUSTTCG");

  if (mapError) {
    throw new Error(`provider_set_map: ${mapError.message}`);
  }

  const providerMap = new Map();
  for (const row of providerMapRows ?? []) {
    providerMap.set(row.canonical_set_code, {
      providerSetId: row.provider_set_id,
      confidence: Number(row.confidence ?? 0),
    });
  }

  const bySet = new Map();
  for (const row of printings ?? []) {
    const setCode = row.set_code;
    const setName = row.set_name;
    const canonicalSlug = row.canonical_slug;
    if (!setCode || !setName || !canonicalSlug) continue;

    const existing = bySet.get(setCode) ?? {
      setCode,
      setName,
      slugs: new Set(),
    };
    existing.slugs.add(canonicalSlug);
    bySet.set(setCode, existing);
  }

  const ranked = [...bySet.values()]
    .map((row) => {
      const mapped = providerMap.get(row.setCode);
      const providerSetId =
        mapped?.confidence > 0 && mapped?.providerSetId
          ? mapped.providerSetId
          : setNameToJustTcgId(row.setName);
      const cardCount = row.slugs.size;

      return {
        setCode: row.setCode,
        setName: row.setName,
        providerSetId,
        cardCount,
        popularityScore: buildPopularityScore(row.setName, cardCount),
      };
    })
    .sort((a, b) => {
      if (b.popularityScore !== a.popularityScore) return b.popularityScore - a.popularityScore;
      if (b.cardCount !== a.cardCount) return b.cardCount - a.cardCount;
      return a.setName.localeCompare(b.setName);
    });

  const dedupedByProviderSet = new Map();
  for (const row of ranked) {
    const existing = dedupedByProviderSet.get(row.providerSetId);
    if (!existing) {
      dedupedByProviderSet.set(row.providerSetId, row);
      continue;
    }

    if (row.popularityScore > existing.popularityScore) {
      dedupedByProviderSet.set(row.providerSetId, row);
      continue;
    }

    if (row.popularityScore === existing.popularityScore && row.cardCount > existing.cardCount) {
      dedupedByProviderSet.set(row.providerSetId, row);
    }
  }

  return [...dedupedByProviderSet.values()].sort((a, b) => {
    if (b.popularityScore !== a.popularityScore) return b.popularityScore - a.popularityScore;
    if (b.cardCount !== a.cardCount) return b.cardCount - a.cardCount;
    return a.setName.localeCompare(b.setName);
  });
}

async function main() {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!cronSecret) throw new Error("CRON_SECRET is required.");
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const reset = args.has("--reset");
  const force = args.has("--force");
  const skipCursorFill = args.has("--skip-cursor-fill");
  const maxSetsArg = [...args].find((arg) => arg.startsWith("--max-sets="));
  const maxSets = maxSetsArg ? Number(maxSetsArg.split("=", 2)[1]) : null;
  const refreshEveryArg = [...args].find((arg) => arg.startsWith("--refresh-every="));
  const refreshEvery = refreshEveryArg ? Math.max(1, Number(refreshEveryArg.split("=", 2)[1])) : 10;
  const maxCursorRunsArg = [...args].find((arg) => arg.startsWith("--max-cursor-runs="));
  const maxCursorRuns = maxCursorRunsArg ? Math.max(1, Number(maxCursorRunsArg.split("=", 2)[1])) : 10;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const baseUrl = resolveBaseUrl();
  const state = reset ? {
    dayKey: currentDayKey(),
    monthKey: currentMonthKey(),
    requestsToday: 0,
    requestsMonth: 0,
    processedSetIds: [],
    completedAt: null,
    lastRun: null,
  } : loadState();

  const rankedSets = await loadRankedSets(supabase);
  const processedSetIds = new Set(force ? [] : state.processedSetIds);
  const queue = rankedSets.filter((row) => force || !processedSetIds.has(row.providerSetId));

  const result = {
    baseUrl,
    dailyLimit: DAILY_LIMIT,
    monthlyLimit: MONTHLY_LIMIT,
    requestsToday: state.requestsToday,
    requestsMonth: state.requestsMonth,
    queuedSets: queue.length,
    processed: [],
    cursorRuns: [],
    stoppedReason: null,
  };

  if (dryRun) {
    result.preview = queue.slice(0, 25);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let sinceLastRefresh = 0;
  let processedCount = 0;

  for (const setRow of queue) {
    if (state.requestsToday >= DAILY_LIMIT) {
      result.stoppedReason = "daily_limit_reached";
      break;
    }
    if (state.requestsMonth >= MONTHLY_LIMIT) {
      result.stoppedReason = "monthly_limit_reached";
      break;
    }
    if (maxSets !== null && processedCount >= maxSets) {
      result.stoppedReason = "max_sets_reached";
      break;
    }

    const params = new URLSearchParams({
      set: setRow.providerSetId,
      force: "1",
    });
    const syncUrl = `${baseUrl}/api/cron/sync-justtcg-prices?${params.toString()}`;
    const syncResult = await callJson(syncUrl, cronSecret);

    state.requestsToday += 1;
    state.requestsMonth += 1;
    processedSetIds.add(setRow.providerSetId);
    state.processedSetIds = [...processedSetIds];
    processedCount += 1;
    sinceLastRefresh += 1;

    let refreshResult = null;
    if (sinceLastRefresh >= refreshEvery) {
      refreshResult = await callJson(`${baseUrl}/api/cron/refresh-derived-signals`, cronSecret);
      sinceLastRefresh = 0;
    }

    result.processed.push({
      setCode: setRow.setCode,
      setName: setRow.setName,
      providerSetId: setRow.providerSetId,
      popularityScore: setRow.popularityScore,
      cardCount: setRow.cardCount,
      itemsFetched: syncResult.itemsFetched ?? null,
      variantMetricsWritten: syncResult.variantMetricsWritten ?? null,
      historyPointsWritten: syncResult.historyPointsWritten ?? null,
      firstError: syncResult.firstError ?? null,
      refreshRowsUpdated: refreshResult?.rowsUpdated ?? null,
    });

    state.lastRun = {
      at: new Date().toISOString(),
      setCode: setRow.setCode,
      setName: setRow.setName,
      providerSetId: setRow.providerSetId,
    };
    saveState(state);
  }

  if (sinceLastRefresh > 0) {
    const refreshResult = await callJson(`${baseUrl}/api/cron/refresh-derived-signals`, cronSecret);
    result.finalRefresh = refreshResult;
  }

  if (!skipCursorFill) {
    let cursorRuns = 0;
    while (cursorRuns < maxCursorRuns) {
      if (state.requestsToday >= DAILY_LIMIT) {
        result.stoppedReason = "daily_limit_reached";
        break;
      }
      if (state.requestsMonth >= MONTHLY_LIMIT) {
        result.stoppedReason = "monthly_limit_reached";
        break;
      }

      const syncResult = await callJson(`${baseUrl}/api/cron/sync-justtcg-prices?force=1`, cronSecret);
      state.requestsToday += 1;
      state.requestsMonth += 1;
      cursorRuns += 1;

      let refreshResult = null;
      if ((cursorRuns % Math.max(1, refreshEvery)) === 0 || syncResult.done) {
        refreshResult = await callJson(`${baseUrl}/api/cron/refresh-derived-signals`, cronSecret);
      }

      result.cursorRuns.push({
        run: cursorRuns,
        setsProcessed: syncResult.setsProcessed ?? null,
        done: Boolean(syncResult.done),
        itemsFetched: syncResult.itemsFetched ?? null,
        variantMetricsWritten: syncResult.variantMetricsWritten ?? null,
        historyPointsWritten: syncResult.historyPointsWritten ?? null,
        firstError: syncResult.firstError ?? null,
        refreshRowsUpdated: refreshResult?.rowsUpdated ?? null,
      });

      state.lastRun = {
        at: new Date().toISOString(),
        setCode: null,
        setName: "cursor-fill",
        providerSetId: "cursor-fill",
      };
      saveState(state);

      if (syncResult.done) {
        break;
      }
    }

    if (result.cursorRuns.length > 0) {
      const refreshResult = await callJson(`${baseUrl}/api/cron/refresh-derived-signals`, cronSecret);
      result.finalRefresh = refreshResult;
    }
  }

  if (!result.stoppedReason) {
    if (result.cursorRuns.length > 0) {
      const lastCursorRun = result.cursorRuns[result.cursorRuns.length - 1];
      result.stoppedReason = lastCursorRun?.done ? "cursor_catalog_complete" : "cursor_run_limit_reached";
    } else {
      result.stoppedReason = queue.length === 0 ? "already_complete_for_month" : "queue_exhausted";
    }
  }

  state.completedAt = new Date().toISOString();
  saveState(state);

  console.log(JSON.stringify({
    ...result,
    requestsToday: state.requestsToday,
    requestsMonth: state.requestsMonth,
    remainingToday: Math.max(0, DAILY_LIMIT - state.requestsToday),
    remainingMonth: Math.max(0, MONTHLY_LIMIT - state.requestsMonth),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
