/**
 * Live JPY→USD rate resolution for the JP pricing pipelines (.mjs world).
 *
 * The .mjs scrape pipelines (scripts/run-yahoo-jp-pipeline.mjs,
 * scripts/run-snkrdunk-pipeline.mjs) can't import the TypeScript
 * lib/pricing/fx.ts, so this mirrors getCurrencyToUsdRateAt's JPY branch:
 * read the freshest JPYUSD row from the daily `fx_rates` series (kept
 * current by /api/cron/ingest-fx-rates) and fall back to the static
 * env/default rate only when the table has no JPYUSD row yet.
 *
 * Both worlds must agree: a row's stamped `fx_rate_used` should be the
 * same number whether it was written by the cron route (TS) or a manual
 * backfill (this helper).
 */

/**
 * @param {object} args
 * @param {import("@supabase/supabase-js").SupabaseClient} args.supabase
 * @param {number} args.fallbackRate - static rate to use when fx_rates has no JPYUSD row
 * @returns {Promise<{ rate: number, rateDate: string | null, source: "FX_RATES_TABLE" | "STATIC_FALLBACK" }>}
 */
export async function resolveJpyToUsdRate({ supabase, fallbackRate }) {
  try {
    const { data, error } = await supabase
      .from("fx_rates")
      .select("rate, rate_date")
      .eq("pair", "JPYUSD")
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data && Number.isFinite(Number(data.rate)) && Number(data.rate) > 0) {
      return { rate: Number(data.rate), rateDate: data.rate_date ?? null, source: "FX_RATES_TABLE" };
    }
  } catch {
    // fall through to the static fallback below
  }
  return { rate: fallbackRate, rateDate: null, source: "STATIC_FALLBACK" };
}
