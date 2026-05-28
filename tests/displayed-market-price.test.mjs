import assert from "node:assert/strict";

import {
  resolveDisplayedMarketPrice,
  formatPriceDisplay,
} from "../lib/pricing/displayed-market-price.ts";

const NOW = Date.UTC(2026, 4, 28, 12, 0, 0);

function isoDaysAgo(days) {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

for (const [value, label] of [
  [0.01, "$0.01"],
  [0.04, "$0.04"],
  [1.3, "$1.30"],
  [2, "$2.00"],
]) {
  const abundant = resolveDisplayedMarketPrice({
    marketPrice: value,
    marketPriceAsOf: isoDaysAgo(1),
    now: NOW,
  });
  assert.equal(abundant.kind, "abundant");
  assert.equal(abundant.price, value);

  const abundantMeta = formatPriceDisplay(abundant);
  assert.equal(abundantMeta.label, label);
  assert.notEqual(abundantMeta.label, "Abundant card");
  assert.equal(abundantMeta.showChangeBadge, false);
  assert.equal(abundantMeta.showConfidencePill, false);
}

const twoDollarCard = resolveDisplayedMarketPrice({
  marketPrice: 2,
  marketPriceAsOf: isoDaysAgo(5),
  now: NOW,
});
assert.equal(twoDollarCard.kind, "abundant");

const justAboveThreshold = resolveDisplayedMarketPrice({
  marketPrice: 2.01,
  marketPriceAsOf: isoDaysAgo(1),
  now: NOW,
});
assert.equal(justAboveThreshold.kind, "live");

const dormantLowValue = resolveDisplayedMarketPrice({
  marketPrice: 0.5,
  marketPriceAsOf: isoDaysAgo(181),
  now: NOW,
});
assert.equal(dormantLowValue.kind, "no_market");

console.log("displayed market price tests passed");
