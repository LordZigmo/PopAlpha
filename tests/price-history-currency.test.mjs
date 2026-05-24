import assert from "node:assert/strict";
import { convertPriceHistoryRowToUsd } from "../lib/pricing/price-history-currency.ts";

export function runPriceHistoryCurrencyTests() {
  assert.equal(
    convertPriceHistoryRowToUsd({
      price: 90.22,
      currency: "USD",
      ts: "2026-05-23T19:15:32.983Z",
    }),
    90.22,
  );

  assert.equal(
    convertPriceHistoryRowToUsd(
      {
        price: 2420,
        currency: "JPY",
        ts: "2026-05-23T19:15:32.983Z",
      },
      [{ pair: "JPYUSD", rate: 0.0068, rate_date: "2026-05-23" }],
    ),
    16.456,
  );

  assert.equal(
    convertPriceHistoryRowToUsd({
      price: 2420,
      currency: null,
      ts: "2026-05-23T19:15:32.983Z",
    }),
    null,
  );

  assert.equal(
    convertPriceHistoryRowToUsd({
      price: 2420,
      currency: "CAD",
      ts: "2026-05-23T19:15:32.983Z",
    }),
    null,
  );
}

runPriceHistoryCurrencyTests();

console.log("price history currency tests passed");
