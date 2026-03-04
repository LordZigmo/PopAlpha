import assert from "node:assert/strict";
import { getEurToUsdRateAt } from "../lib/pricing/fx";

type QueryRecorder = {
  eqCalls: Array<{ column: string; value: string }>;
  lteCalls: Array<{ column: string; value: string }>;
  orderCalls: Array<{ column: string; ascending: boolean }>;
  limitCalls: number[];
};

function buildMockSupabase(options: {
  rateRow?: { rate: number; rate_date: string } | null;
  error?: { message: string } | null;
  recorder?: QueryRecorder;
}) {
  const recorder = options.recorder ?? {
    eqCalls: [],
    lteCalls: [],
    orderCalls: [],
    limitCalls: [],
  };

  const chain = {
    select: () => chain,
    eq: (column: string, value: string) => {
      recorder.eqCalls.push({ column, value });
      return chain;
    },
    lte: (column: string, value: string) => {
      recorder.lteCalls.push({ column, value });
      return chain;
    },
    order: (column: string, params: { ascending: boolean }) => {
      recorder.orderCalls.push({ column, ascending: params.ascending });
      return chain;
    },
    limit: (value: number) => {
      recorder.limitCalls.push(value);
      return chain;
    },
    maybeSingle: async () => ({
      data: options.rateRow ?? null,
      error: options.error ?? null,
    }),
  };

  const supabase = {
    from: (table: string) => {
      assert.equal(table, "fx_rates");
      return chain;
    },
  };

  return { supabase, recorder };
}

export async function runFxRateLookupTests() {
  {
    const { supabase, recorder } = buildMockSupabase({
      rateRow: { rate: 1.1649, rate_date: "2026-03-04" },
    });
    const result = await getEurToUsdRateAt({
      supabase: supabase as never,
      asOf: "2026-03-08T12:00:00.000Z", // weekend lookup should use prior business-day row
    });

    assert.equal(result.rate, 1.1649);
    assert.equal(result.fxAsOf, "2026-03-04");
    assert.equal(result.fxSource, "FX_RATES_TABLE");
    assert.deepEqual(recorder.eqCalls, [{ column: "pair", value: "EURUSD" }]);
    assert.deepEqual(recorder.lteCalls, [{ column: "rate_date", value: "2026-03-08" }]);
    assert.deepEqual(recorder.orderCalls, [{ column: "rate_date", ascending: false }]);
    assert.deepEqual(recorder.limitCalls, [1]);
  }

  {
    process.env.EUR_TO_USD_RATE = "1.23";
    const { supabase } = buildMockSupabase({
      rateRow: null,
      error: { message: "not found" },
    });

    const result = await getEurToUsdRateAt({
      supabase: supabase as never,
      asOf: "2026-03-04T00:00:00.000Z",
    });

    assert.equal(result.rate, 1.23);
    assert.equal(result.fxAsOf, null);
    assert.equal(result.fxSource, "ENV_EUR_TO_USD_RATE");
  }

  {
    delete process.env.EUR_TO_USD_RATE;
    const { supabase } = buildMockSupabase({
      rateRow: null,
      error: { message: "missing" },
    });

    const result = await getEurToUsdRateAt({
      supabase: supabase as never,
      asOf: "invalid-date",
    });

    assert.equal(result.rate, 1.08);
    assert.equal(result.fxAsOf, null);
    assert.equal(result.fxSource, "ENV_EUR_TO_USD_RATE");
  }
}
