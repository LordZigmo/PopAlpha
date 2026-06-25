import { dbAdmin } from "@/lib/db/admin";

const JOB = "fx_rates_ingest";
const SOURCE = "ECB_FRANKFURTER";
const DEFAULT_DAYS_BACK = 7;

// Every FX pair we keep fresh from the ECB/Frankfurter daily series.
// EURUSD feeds Scrydex EUR→USD conversion; JPYUSD feeds the JP price
// pipelines (Yahoo! Auctions JP + Snkrdunk), which previously baked a
// frozen 0.0068 (~¥147/$1) constant into every row. Frankfurter derives
// every pair from the ECB EUR reference rates, so `from=JPY&to=USD`
// returns USD-per-1-yen — exactly the multiplier the pipelines apply.
const PAIRS: ReadonlyArray<{ pair: string; base: string; quote: string }> = [
  { pair: "EURUSD", base: "EUR", quote: "USD" },
  { pair: "JPYUSD", base: "JPY", quote: "USD" },
];

type FxApiResponse = {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
};

type FxRateWriteRow = {
  source: string;
  pair: string;
  base_currency: string;
  quote_currency: string;
  rate: number;
  rate_date: string;
  published_at: null;
  fetched_at: string;
  raw_payload: Record<string, unknown>;
};

type FxIngestResult = {
  ok: boolean;
  job: string;
  source: string;
  startedAt: string;
  endedAt: string;
  daysRequested: number;
  daysFetched: number;
  ratesPrepared: number;
  ratesUpserted: number;
  firstError: string | null;
  sampleRates: Array<{ pair: string; rateDate: string; rate: number }>;
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isoDateDaysAgo(daysAgo: number): string {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() - daysAgo);
  return now.toISOString().slice(0, 10);
}

async function fetchDailyRate(
  pairConfig: { pair: string; base: string; quote: string },
  date: string,
): Promise<FxRateWriteRow> {
  const endpoint = `https://api.frankfurter.app/${date}?from=${pairConfig.base}&to=${pairConfig.quote}`;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`fx fetch failed (${res.status}): ${endpoint}`);
  }

  const json = (await res.json()) as FxApiResponse;
  const base = String(json.base ?? "").toUpperCase();
  const rateDate = String(json.date ?? "").trim();
  const rate = json.rates?.[pairConfig.quote];
  if (base !== pairConfig.base) throw new Error(`fx fetch invalid base '${base}' for ${endpoint}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error(`fx fetch invalid date '${rateDate}' for ${endpoint}`);
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`fx fetch invalid ${pairConfig.pair} rate for ${endpoint}`);
  }

  return {
    source: SOURCE,
    pair: pairConfig.pair,
    base_currency: pairConfig.base,
    quote_currency: pairConfig.quote,
    rate,
    rate_date: rateDate,
    published_at: null,
    fetched_at: new Date().toISOString(),
    raw_payload: {
      endpoint,
      amount: json.amount ?? null,
      base,
      date: rateDate,
      rates: json.rates ?? null,
    },
  };
}

export async function runFxRatesIngest(opts: {
  daysBack?: number;
} = {}): Promise<FxIngestResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const daysBack = parsePositiveInt(opts.daysBack, DEFAULT_DAYS_BACK);

  let firstError: string | null = null;
  let daysFetched = 0;
  let ratesPrepared = 0;
  let ratesUpserted = 0;
  const sampleRates: Array<{ pair: string; rateDate: string; rate: number }> = [];

  const { data: runRow, error: runStartError } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "fx",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        mode: "daily-fx",
        daysBack,
        pairs: PAIRS.map((p) => p.pair),
        source: SOURCE,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (runStartError) {
    throw new Error(`ingest_runs(start): ${runStartError.message}`);
  }

  const runId = runRow?.id ?? null;

  try {
    const rows: FxRateWriteRow[] = [];
    // One pair failing (or one day missing) must not abort the others —
    // record the first error and keep going so a JPY hiccup never starves
    // the EUR series (or vice versa). A fully empty result still surfaces
    // via firstError + ratesUpserted === 0.
    for (const pairConfig of PAIRS) {
      for (let daysAgo = 0; daysAgo < daysBack; daysAgo += 1) {
        const day = isoDateDaysAgo(daysAgo);
        try {
          const row = await fetchDailyRate(pairConfig, day);
          daysFetched += 1;
          rows.push(row);
        } catch (error) {
          if (!firstError) firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    // Dedup per (pair, rate_date) — a calendar date carries one row PER
    // pair, so keying on rate_date alone would drop EURUSD or JPYUSD.
    const byPairDate = new Map<string, FxRateWriteRow>();
    for (const row of rows) {
      const key = `${row.pair}:${row.rate_date}`;
      const current = byPairDate.get(key);
      if (!current || current.fetched_at < row.fetched_at) {
        byPairDate.set(key, row);
      }
    }
    const dedupedRows = [...byPairDate.values()];
    ratesPrepared = dedupedRows.length;

    if (dedupedRows.length > 0) {
      const { data, error } = await supabase
        .from("fx_rates")
        .upsert(dedupedRows, { onConflict: "source,pair,rate_date" })
        .select("id, pair, rate_date, rate");
      if (error) throw new Error(`fx_rates(upsert): ${error.message}`);
      ratesUpserted = (data ?? []).length;
      for (const row of (data ?? []) as Array<{ pair: string; rate_date: string; rate: number }>) {
        if (sampleRates.length >= 10) break;
        sampleRates.push({ pair: row.pair, rateDate: row.rate_date, rate: row.rate });
      }
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const result: FxIngestResult = {
    ok: firstError === null,
    job: JOB,
    source: SOURCE,
    startedAt,
    endedAt,
    daysRequested: daysBack,
    daysFetched,
    ratesPrepared,
    ratesUpserted,
    firstError,
    sampleRates,
  };

  if (runId) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: result.ok,
        items_fetched: ratesPrepared,
        items_upserted: ratesUpserted,
        items_failed: firstError ? 1 : 0,
        ended_at: endedAt,
        meta: {
          mode: "daily-fx",
          daysBack,
          pairs: PAIRS.map((p) => p.pair),
          source: SOURCE,
          daysFetched,
          ratesPrepared,
          ratesUpserted,
          firstError,
          sampleRates,
        },
      })
      .eq("id", runId);
  }

  return result;
}
