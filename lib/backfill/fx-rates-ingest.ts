import { dbAdmin } from "@/lib/db/admin";

const JOB = "fx_rates_ingest";
const SOURCE = "ECB_FRANKFURTER";
const PAIR = "EURUSD";
const DEFAULT_DAYS_BACK = 7;

type FxApiResponse = {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
};

type FxRateWriteRow = {
  source: string;
  pair: string;
  base_currency: "EUR";
  quote_currency: "USD";
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
  sampleRates: Array<{ rateDate: string; rate: number }>;
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

async function fetchEurUsdDaily(date: string): Promise<FxRateWriteRow> {
  const endpoint = `https://api.frankfurter.app/${date}?from=EUR&to=USD`;
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
  const rate = json.rates?.USD;
  if (base !== "EUR") throw new Error(`fx fetch invalid base '${base}' for ${endpoint}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error(`fx fetch invalid date '${rateDate}' for ${endpoint}`);
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`fx fetch invalid EURUSD rate for ${endpoint}`);
  }

  return {
    source: SOURCE,
    pair: PAIR,
    base_currency: "EUR",
    quote_currency: "USD",
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
  const sampleRates: Array<{ rateDate: string; rate: number }> = [];

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
        pair: PAIR,
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
    for (let daysAgo = 0; daysAgo < daysBack; daysAgo += 1) {
      const day = isoDateDaysAgo(daysAgo);
      const row = await fetchEurUsdDaily(day);
      daysFetched += 1;
      rows.push(row);
    }

    const byRateDate = new Map<string, FxRateWriteRow>();
    for (const row of rows) {
      const current = byRateDate.get(row.rate_date);
      if (!current || current.fetched_at < row.fetched_at) {
        byRateDate.set(row.rate_date, row);
      }
    }
    const dedupedRows = [...byRateDate.values()];
    ratesPrepared = dedupedRows.length;

    if (dedupedRows.length > 0) {
      const { data, error } = await supabase
        .from("fx_rates")
        .upsert(dedupedRows, { onConflict: "source,pair,rate_date" })
        .select("id, rate_date, rate");
      if (error) throw new Error(`fx_rates(upsert): ${error.message}`);
      ratesUpserted = (data ?? []).length;
      for (const row of (data ?? []) as Array<{ rate_date: string; rate: number }>) {
        if (sampleRates.length >= 10) break;
        sampleRates.push({ rateDate: row.rate_date, rate: row.rate });
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
          pair: PAIR,
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
