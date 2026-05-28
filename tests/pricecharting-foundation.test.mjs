import assert from "node:assert/strict";
import {
  normalizePriceChartingProductRecord,
  parsePriceChartingCentAmount,
  parsePriceChartingCsv,
} from "../lib/backfill/pricecharting-normalize.ts";
import {
  buildPriceChartingMatchDecision,
  extractPriceChartingCardNumber,
  isPriceChartingCanonicalHeadlineProduct,
  isPriceChartingEnglishSingleCardProduct,
  normalizePriceChartingCardNumber,
} from "../lib/backfill/pricecharting-match.ts";

export async function runPriceChartingFoundationTests() {
  assert.equal(parsePriceChartingCentAmount("17244"), 172.44);
  assert.equal(parsePriceChartingCentAmount("0"), null);
  assert.equal(parsePriceChartingCentAmount(""), null);

  const csvRows = parsePriceChartingCsv([
    "id,product-name,console-name,genre,tcg-id,loose-price,graded-price,manual-only-price,sales-volume",
    "pc-4,\"Charizard #4\",Pokemon Base Set,Pokemon Card,42382,29898,90000,120000,123",
    "game-1,EarthBound,Super Nintendo,RPG,17244,50000,53000,25",
  ].join("\n"));
  assert.equal(csvRows.length, 2);
  assert.equal(csvRows[0]["product-name"], "Charizard #4");

  const normalized = normalizePriceChartingProductRecord({
    record: csvRows[0],
    observedAt: "2026-05-27T13:00:00.000Z",
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.row.loose_price_usd, 298.98);
  assert.equal(normalized.row.grade_9_price_usd, 900);
  assert.equal(normalized.row.grade_10_price_usd, 1200);
  assert.equal(normalized.row.sales_volume, 123);
  assert.equal(normalized.row.tcg_id, "42382");

  const apiNormalized = normalizePriceChartingProductRecord({
    record: {
      "bgs-10-price": 3853600,
      "box-only-price": 468018,
      "cib-price": 72147,
      "condition-17-price": 718173,
      "condition-18-price": 1778600,
      "console-name": "Pokemon Base Set",
      epid: "24043367933",
      genre: "Pokemon Card",
      "graded-price": 252280,
      id: "630417",
      "loose-price": 29662,
      "manual-only-price": 2964313,
      "new-price": 131250,
      "product-name": "Charizard #4",
      "release-date": "1999-01-09",
      "sales-volume": "2206",
      status: "success",
      "tcg-id": "42382",
    },
    observedAt: "2026-05-27T13:05:00.000Z",
    importSource: "api",
  });
  assert.equal(apiNormalized.ok, true);
  assert.equal(apiNormalized.row.product_id, "630417");
  assert.equal(apiNormalized.row.loose_price_usd, 296.62);
  assert.equal(apiNormalized.row.grade_9_price_usd, 2522.8);
  assert.equal(apiNormalized.row.grade_10_price_usd, 29643.13);
  assert.equal(apiNormalized.row.tcg_id, "42382");

  const skipped = normalizePriceChartingProductRecord({
    record: csvRows[1],
    observedAt: "2026-05-27T13:00:00.000Z",
  });
  assert.deepEqual(skipped, { ok: false, reason: "NON_POKEMON_CARD" });

  const sealedSkipped = normalizePriceChartingProductRecord({
    record: {
      id: "sealed-1",
      "product-name": "Pokemon Base Set Booster Box",
      "console-name": "Pokemon Base Set",
      genre: "Sealed Product",
    },
    observedAt: "2026-05-27T13:00:00.000Z",
  });
  assert.deepEqual(sealedSkipped, { ok: false, reason: "NON_POKEMON_CARD" });

  assert.equal(extractPriceChartingCardNumber("Charizard #4"), "4");
  assert.equal(extractPriceChartingCardNumber("Pikachu 25/102"), "25");
  assert.equal(normalizePriceChartingCardNumber("004"), "4");

  const canonicalCards = [
    {
      slug: "base-set-4-charizard",
      canonical_name: "Charizard",
      set_name: "Base Set",
      card_number: "4",
      language: "EN",
    },
    {
      slug: "base-set-25-pikachu",
      canonical_name: "Pikachu",
      set_name: "Base Set",
      card_number: "25",
      language: "EN",
    },
  ];
  const printings = [
    {
      id: "printing-charizard-holo",
      canonical_slug: "base-set-4-charizard",
      language: "EN",
      finish: "HOLO",
      edition: "UNLIMITED",
      stamp: null,
    },
    {
      id: "printing-pikachu",
      canonical_slug: "base-set-25-pikachu",
      language: "EN",
      finish: "NON_HOLO",
      edition: "UNLIMITED",
      stamp: null,
    },
    {
      id: "printing-pikachu-reverse",
      canonical_slug: "base-set-25-pikachu",
      language: "EN",
      finish: "REVERSE_HOLO",
      edition: "UNLIMITED",
      stamp: null,
    },
  ];

  assert.deepEqual(
    buildPriceChartingMatchDecision({
      product: {
        product_id: "pc-4",
        product_name: "Charizard #4",
        console_name: "Pokemon Base Set",
        genre: "Pokemon Card",
      },
      canonicalCards,
      printings,
    }),
    {
      productId: "pc-4",
      canonicalSlug: "base-set-4-charizard",
      printingId: "printing-charizard-holo",
      matchStatus: "MATCHED",
      matchType: "AUTO_EXACT_PRINTING_OR_CANONICAL",
      matchConfidence: 98,
      matchReason: null,
      identity: {
        productName: "Charizard #4",
        consoleName: "Pokemon Base Set",
        extractedCardNumber: "4",
        canonicalName: "Charizard",
        setName: "Base Set",
        printingResolution: null,
      },
    },
  );

  const shadowless = buildPriceChartingMatchDecision({
    product: {
      product_id: "pc-shadowless",
      product_name: "Charizard #4 Shadowless",
      console_name: "Pokemon Base Set",
      genre: "Pokemon Card",
    },
    canonicalCards,
    printings,
  });
  assert.equal(shadowless.matchStatus, "NEEDS_REVIEW");
  assert.equal(shadowless.matchType, "AUTO_CANONICAL_VARIANT_REVIEW");
  assert.equal(shadowless.matchReason, "VARIANT_REQUIRES_PRINTING_REVIEW");

  const reverseHolo = buildPriceChartingMatchDecision({
    product: {
      product_id: "pc-reverse",
      product_name: "Pikachu [Reverse Holo] #25",
      console_name: "Pokemon Base Set",
      genre: "Pokemon Card",
    },
    canonicalCards,
    printings,
  });
  assert.equal(reverseHolo.matchStatus, "MATCHED");
  assert.equal(reverseHolo.printingId, "printing-pikachu-reverse");

  const cosmosHolo = buildPriceChartingMatchDecision({
    product: {
      product_id: "pc-cosmos",
      product_name: "Pikachu [Cosmos Holo] #25",
      console_name: "Pokemon Base Set",
      genre: "Pokemon Card",
    },
    canonicalCards,
    printings,
  });
  assert.equal(cosmosHolo.matchStatus, "NEEDS_REVIEW");
  assert.equal(cosmosHolo.matchReason, "VARIANT_REQUIRES_PRINTING_REVIEW");

  const regionalChampionship = buildPriceChartingMatchDecision({
    product: {
      product_id: "pc-regional",
      product_name: "Pikachu [Regional Championships] #25",
      console_name: "Pokemon Base Set",
      genre: "Pokemon Card",
    },
    canonicalCards,
    printings,
  });
  assert.equal(regionalChampionship.matchStatus, "NEEDS_REVIEW");

  assert.equal(isPriceChartingEnglishSingleCardProduct({
    product_id: "pc-english",
    product_name: "Pikachu #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), true);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-english",
    product_name: "Pikachu #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), true);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-reverse-headline",
    product_name: "Pikachu [Reverse Holo] #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-holo-headline",
    product_name: "Pikachu [Holo] #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-shadowless-headline",
    product_name: "Pikachu Shadowless #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-cosmos-headline",
    product_name: "Pikachu [Cosmos Holo] #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-gamestop-headline",
    product_name: "Pikachu GameStop Promo #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-prize-pack-headline",
    product_name: "Pikachu Prize Pack #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-league-headline",
    product_name: "Pikachu League #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-jumbo-headline",
    product_name: "Pikachu Jumbo #25",
    console_name: "Pokemon Base Set",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingEnglishSingleCardProduct({
    product_id: "pc-jp",
    product_name: "Pikachu #25",
    console_name: "Pokemon Japanese Promo",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-jp-headline",
    product_name: "Pikachu #25",
    console_name: "Pokemon Japanese Promo",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingEnglishSingleCardProduct({
    product_id: "pc-topps",
    product_name: "Pikachu #25",
    console_name: "Pokemon 2000 Topps Chrome",
    genre: "Pokemon Card",
  }), false);
  assert.equal(isPriceChartingCanonicalHeadlineProduct({
    product_id: "pc-topps-headline",
    product_name: "Pikachu #25",
    console_name: "Pokemon 2000 Topps Chrome",
    genre: "Pokemon Card",
  }), false);
}

await runPriceChartingFoundationTests();

console.log("pricecharting foundation tests passed");
