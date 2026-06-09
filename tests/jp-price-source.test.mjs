import assert from "node:assert/strict";

import {
  selectJpPriceSource,
  formatJpSourcePriceLabel,
} from "../lib/pricing/jp-price-source.ts";

// Snkrdunk's English API serves USD only; snkrdunk_price_jpy in the DB
// is back-computed from that USD via an FX rate at write time. The
// picker must never surface it as a native yen price — renderers would
// lead with "¥3,200" for a number no seller ever listed.
{
  const pick = selectJpPriceSource({
    yahooJpPrice: null,
    yahooJpPriceJpy: null,
    yahooJpSampleCount: null,
    snkrdunkPrice: 21.45,
    snkrdunkPriceJpy: 3155, // FX-derived — must be ignored
    snkrdunkSampleCount: 12,
  });
  assert.equal(pick.source, "snkrdunk");
  assert.equal(pick.price, 21.45);
  assert.equal(pick.priceJpy, null, "snkrdunk priceJpy must never be emitted");
  assert.equal(formatJpSourcePriceLabel(pick), "$21.45");
}

// Snkrdunk winning the sample-count tie-break still suppresses the
// derived JPY even when Yahoo (the loser) had a native value.
{
  const pick = selectJpPriceSource({
    yahooJpPrice: 20.0,
    yahooJpPriceJpy: 2900,
    yahooJpSampleCount: 4,
    snkrdunkPrice: 22.0,
    snkrdunkPriceJpy: 3200,
    snkrdunkSampleCount: 9,
  });
  assert.equal(pick.source, "snkrdunk");
  assert.equal(pick.priceJpy, null);
  assert.equal(formatJpSourcePriceLabel(pick), "$22.00");
}

// Yahoo! JP captures the seller-listed yen value at observation time —
// that native JPY still leads the label.
{
  const pick = selectJpPriceSource({
    yahooJpPrice: 21.0,
    yahooJpPriceJpy: 3100,
    yahooJpSampleCount: 8,
    snkrdunkPrice: 19.0,
    snkrdunkPriceJpy: 2800,
    snkrdunkSampleCount: 3,
  });
  assert.equal(pick.source, "yahoo_jp");
  assert.equal(pick.priceJpy, 3100);
  assert.equal(formatJpSourcePriceLabel(pick), "¥3,100 ($21.00)");
}

// Below the 3-sample floor neither source qualifies.
{
  const pick = selectJpPriceSource({
    yahooJpPrice: 21.0,
    yahooJpPriceJpy: 3100,
    yahooJpSampleCount: 2,
    snkrdunkPrice: 19.0,
    snkrdunkPriceJpy: 2800,
    snkrdunkSampleCount: 1,
  });
  assert.equal(pick.source, null);
  assert.equal(pick.price, null);
  assert.equal(pick.priceJpy, null);
}

console.log("jp price source tests passed");
