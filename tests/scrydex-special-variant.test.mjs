import assert from "node:assert/strict";
import { buildLegacyVariantRef } from "../lib/providers/justtcg.ts";
import {
  normalizeScrydexStampToken,
  parseScrydexVariantSemantics,
} from "../lib/backfill/scrydex-variant-semantics.ts";
import { chooseSinglePrinting } from "../lib/backfill/pokemontcg-normalized-match.ts";

function makeObservation(overrides = {}) {
  return {
    id: "obs-1",
    provider: "SCRYDEX",
    provider_set_id: "sv3pt5",
    provider_card_id: "sv3pt5-7",
    provider_variant_id: "sv3pt5-7:normal",
    asset_type: "single",
    normalized_card_number: "7",
    normalized_finish: "NON_HOLO",
    normalized_edition: "UNLIMITED",
    normalized_stamp: "NONE",
    normalized_language: "en",
    observed_at: "2026-03-16T06:55:17.058+00:00",
    ...overrides,
  };
}

function makePrinting(overrides = {}) {
  return {
    id: "printing-1",
    canonical_slug: "151-7-squirtle",
    set_code: "sv3pt5",
    card_number: "7",
    language: "EN",
    finish: "NON_HOLO",
    edition: "UNLIMITED",
    stamp: null,
    ...overrides,
  };
}

function runScrydexSpecialVariantTests() {
  const pokemonCenter = parseScrydexVariantSemantics("pokemoncenterstamp");
  assert.equal(pokemonCenter.normalizedStamp, "POKEMON_CENTER");
  assert.equal(pokemonCenter.normalizedFinish, "UNKNOWN");
  assert.equal(pokemonCenter.hasSpecialVariantToken, true);
  assert.equal(pokemonCenter.stampLabel, "pokemon center");
  const pokemonCenterVariantRef = buildLegacyVariantRef(
    "pokemoncenterstamp",
    pokemonCenter.normalizedEdition,
    pokemonCenter.stampLabel,
    "Near Mint",
    "English",
    "RAW",
  );
  assert.ok(!pokemonCenterVariantRef.includes(":none:"));
  assert.match(pokemonCenterVariantRef, /:pokemon-center:/);

  const masterBall = parseScrydexVariantSemantics("masterballreverseholofoil");
  assert.equal(masterBall.normalizedStamp, "MASTER_BALL_PATTERN");
  assert.equal(masterBall.normalizedFinish, "REVERSE_HOLO");
  assert.equal(masterBall.hasSpecialVariantToken, true);

  const normal = parseScrydexVariantSemantics("normal");
  assert.equal(normal.normalizedStamp, "NONE");
  assert.equal(normal.normalizedFinish, "NON_HOLO");
  assert.equal(normal.hasSpecialVariantToken, false);

  assert.equal(normalizeScrydexStampToken("pokemon center"), "POKEMON_CENTER");
  assert.equal(normalizeScrydexStampToken("masterball"), "MASTER_BALL_PATTERN");
  assert.equal(normalizeScrydexStampToken("poke ball"), "POKE_BALL_PATTERN");

  const stampedDecision = chooseSinglePrinting({
    observation: makeObservation({
      provider_variant_id: "sv3pt5-7:pokemoncenterstamp",
      normalized_finish: "UNKNOWN",
      normalized_stamp: "POKEMON_CENTER",
    }),
    canonicalSetCode: "sv3pt5",
    printingRows: [
      makePrinting(),
      makePrinting({
        id: "printing-2",
        finish: "REVERSE_HOLO",
      }),
    ],
  });
  assert.equal(stampedDecision.matched, false);
  assert.equal(stampedDecision.reason, "SPECIAL_VARIANT_EXACT_MATCH_REQUIRED");

  const masterBallDecision = chooseSinglePrinting({
    observation: makeObservation({
      provider_variant_id: "sv3pt5-7:masterballreverseholofoil",
      normalized_finish: "REVERSE_HOLO",
      normalized_stamp: "MASTER_BALL_PATTERN",
    }),
    canonicalSetCode: "sv3pt5",
    printingRows: [
      makePrinting(),
      makePrinting({
        id: "printing-2",
        finish: "REVERSE_HOLO",
      }),
    ],
  });
  assert.equal(masterBallDecision.matched, false);
  assert.equal(masterBallDecision.reason, "SPECIAL_VARIANT_EXACT_MATCH_REQUIRED");

  const normalDecision = chooseSinglePrinting({
    observation: makeObservation(),
    canonicalSetCode: "sv3pt5",
    printingRows: [makePrinting()],
  });
  assert.equal(normalDecision.matched, true);
  assert.equal(normalDecision.matchType, "PRINTING_EXACT");

  const reverseDecision = chooseSinglePrinting({
    observation: makeObservation({
      provider_variant_id: "sv3pt5-7:reverseholofoil",
      normalized_finish: "REVERSE_HOLO",
    }),
    canonicalSetCode: "sv3pt5",
    printingRows: [
      makePrinting({
        id: "printing-2",
        finish: "REVERSE_HOLO",
      }),
    ],
  });
  assert.equal(reverseDecision.matched, true);
  assert.equal(reverseDecision.matchType, "PRINTING_EXACT");
}

runScrydexSpecialVariantTests();

console.log("scrydex special variant tests passed");
