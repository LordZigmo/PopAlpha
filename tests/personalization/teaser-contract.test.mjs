import assert from "node:assert/strict";

import {
  COLLECTOR_INSIGHT_TEASER_KEYS,
  toCollectorInsightTeaser,
} from "@/lib/personalization/explanation/teaser.ts";

// Contract: the free-tier teaser must NEVER carry the Pro-only depth of
// a Collector Insight. Every depth field below is poisoned with a
// sentinel; if any sentinel survives the projection, paid content is
// leaking to free users.
const PRO_ONLY_SENTINEL = "PRO_ONLY_CONTENT_MUST_NOT_LEAK";

const FORBIDDEN_KEYS = [
  "roleInCollection",
  "tradeoff",
  "bestMove",
  "popAlphaRead",
  "dataBasis",
  "generated_at",
  "source_version",
  "failureReason",
];

export async function runTeaserContractTests() {
  // A fully-populated insight, including every Pro-only field and the
  // provenance fields, plus an unknown future field — the projection
  // must drop all of them.
  const fullInsight = {
    fitLabel: "Strong Fit for Your Collection",
    fitScore: 82,
    collectorType: "Art-Driven Collector",
    summary: "This card lines up with your alt-art focus.",
    confidence: "high",
    roleInCollection: PRO_ONLY_SENTINEL,
    tradeoff: PRO_ONLY_SENTINEL,
    bestMove: PRO_ONLY_SENTINEL,
    popAlphaRead: PRO_ONLY_SENTINEL,
    dataBasis: PRO_ONLY_SENTINEL,
    generated_at: PRO_ONLY_SENTINEL,
    source: "llm",
    source_version: PRO_ONLY_SENTINEL,
    failureReason: PRO_ONLY_SENTINEL,
    someFutureProField: PRO_ONLY_SENTINEL,
  };

  const teaser = toCollectorInsightTeaser(fullInsight);

  // 1. Exact key set: nothing beyond the declared allow-list.
  assert.deepEqual(
    Object.keys(teaser).sort(),
    [...COLLECTOR_INSIGHT_TEASER_KEYS].sort(),
    "teaser keys must exactly match the declared allow-list",
  );

  // 2. No forbidden key survives.
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(key in teaser, false, `teaser must not contain ${key}`);
  }

  // 3. No sentinel value survives anywhere in the serialized payload —
  //    catches leak-by-renaming, not just leak-by-key.
  assert.equal(
    JSON.stringify(teaser).includes(PRO_ONLY_SENTINEL),
    false,
    "teaser payload must not contain any Pro-only content",
  );

  // 4. The allowed fields actually flow through (the teaser is a real
  //    preview, not an empty shell) and source is pinned to the cheap
  //    deterministic path.
  assert.equal(teaser.fitLabel, fullInsight.fitLabel);
  assert.equal(teaser.fitScore, fullInsight.fitScore);
  assert.equal(teaser.collectorType, fullInsight.collectorType);
  assert.equal(teaser.summary, fullInsight.summary);
  assert.equal(teaser.confidence, fullInsight.confidence);
  assert.equal(teaser.source, "template");

  console.log("  teaser-contract: ok");
}
