import assert from "node:assert/strict";
import { buildSearchCardResults } from "../lib/search/cards.mjs";
import { normalizeSearchInput } from "../lib/search/normalize.mjs";

export function runSearchCardsTests() {
  const aliasResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base",
        card_number: "4",
        year: 1999,
        primary_image_url: "https://img.example/charizard.png",
        search_doc_norm: "charizard base 4 1999",
      },
      {
        canonical_slug: "base-2-blastoise",
        canonical_name: "Blastoise",
        set_name: "Base",
        card_number: "2",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "blastoise base 2 1999",
      },
    ],
    aliasRows: [{ canonical_slug: "base-4-charizard", alias_norm: "bubble mew charizard" }],
    query: normalizeSearchInput("bubble mew charizard"),
    limit: 20,
  });

  assert.equal(aliasResult.length, 1);
  assert.deepEqual(aliasResult[0], {
    canonical_slug: "base-4-charizard",
    canonical_name: "Charizard",
    set_name: "Base",
    card_number: "4",
    year: 1999,
    primary_image_url: "https://img.example/charizard.png",
  });

  const tokenResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "jungle-64-poke-ball",
        canonical_name: "Poke Ball",
        set_name: "Jungle",
        card_number: "64",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "poke ball jungle 64 1999",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("64 jungle"),
    limit: 20,
  });

  assert.equal(tokenResult.length, 1);
  assert.equal(tokenResult[0]?.canonical_slug, "jungle-64-poke-ball");

  const orderFlexibleResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "base set charizard 4",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("charizard base 4"),
    limit: 20,
  });

  assert.equal(orderFlexibleResult.length, 1);
  assert.equal(orderFlexibleResult[0]?.canonical_slug, "base-4-charizard");

  const aliasOnlyResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "pf-232-mew-ex",
        canonical_name: "Mew ex",
        set_name: "Paldean Fates",
        card_number: "232",
        year: 2024,
        primary_image_url: null,
        search_doc_norm: "mew ex paldean fates 232 2024",
      },
    ],
    aliasRows: [{ canonical_slug: "pf-232-mew-ex", alias_norm: "bubble mew" }],
    query: normalizeSearchInput("bubble mew"),
    limit: 20,
  });

  assert.equal(aliasOnlyResult.length, 1);
  assert.equal(aliasOnlyResult[0]?.canonical_slug, "pf-232-mew-ex");

  const setNumberPriority = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 1999",
      },
      {
        canonical_slug: "gym-44-base-set-trainer",
        canonical_name: "Base Set Trainer 44",
        set_name: "Gym Heroes",
        card_number: "44",
        year: 2000,
        primary_image_url: null,
        search_doc_norm: "base set trainer 44 gym heroes 2000",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("base set 4"),
    limit: 20,
  });

  assert.equal(setNumberPriority[0]?.canonical_slug, "base-4-charizard");

  const exactNameBeatsAliasOnly = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 1999",
      },
      {
        canonical_slug: "expedition-40-dragon",
        canonical_name: "Dragonair",
        set_name: "Expedition",
        card_number: "40",
        year: 2002,
        primary_image_url: null,
        search_doc_norm: "dragonair expedition 40 2002",
      },
    ],
    aliasRows: [{ canonical_slug: "expedition-40-dragon", alias_norm: "charizard" }],
    query: normalizeSearchInput("charizard"),
    limit: 20,
  });

  assert.equal(exactNameBeatsAliasOnly[0]?.canonical_slug, "base-4-charizard");

  const aliasBeatsGeneric = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 1999",
      },
      {
        canonical_slug: "base-44-zard-trainer",
        canonical_name: "Zard Trainer",
        set_name: "Base Set",
        card_number: "44",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "zard trainer base set 44 1999",
      },
    ],
    aliasRows: [{ canonical_slug: "base-4-charizard", alias_norm: "zard base 4" }],
    query: normalizeSearchInput("zard base 4"),
    limit: 20,
  });

  assert.equal(aliasBeatsGeneric[0]?.canonical_slug, "base-4-charizard");

  const charizardFourRanksBaseCardFirst = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 102 1999",
      },
      {
        canonical_slug: "lost-origin-tg03-charizard",
        canonical_name: "Charizard",
        set_name: "Lost Origin",
        card_number: "TG03",
        year: 2022,
        primary_image_url: null,
        search_doc_norm: "charizard lost origin trainer gallery 4 2022 tg03",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("charizard 4"),
    limit: 20,
  });

  assert.equal(charizardFourRanksBaseCardFirst[0]?.canonical_slug, "base-4-charizard");

  const numericTokenBoundaryResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 102 1999",
      },
      {
        canonical_slug: "promo-999-charizard-2024",
        canonical_name: "Charizard",
        set_name: "Promo",
        card_number: "TG03",
        year: 2024,
        primary_image_url: null,
        search_doc_norm: "charizard promo tg03 2024",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("charizard 4"),
    limit: 20,
  });

  assert.equal(numericTokenBoundaryResult.length, 1);
  assert.equal(numericTokenBoundaryResult[0]?.canonical_slug, "base-4-charizard");

  const setAndNumberStillWins = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 102 1999",
      },
      {
        canonical_slug: "expedition-4-charizard",
        canonical_name: "Charizard",
        set_name: "Expedition",
        card_number: "4",
        year: 2002,
        primary_image_url: null,
        search_doc_norm: "charizard expedition 4 165 2002",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("base set charizard 4"),
    limit: 20,
  });

  assert.equal(setAndNumberStillWins[0]?.canonical_slug, "base-4-charizard");

  const bareNameAndNumberPrefersOriginalEra = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "base-4-charizard",
        canonical_name: "Charizard",
        set_name: "Base Set",
        card_number: "4",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "charizard base set 4 102 1999",
      },
      {
        canonical_slug: "expedition-4-charizard",
        canonical_name: "Charizard",
        set_name: "Expedition",
        card_number: "4",
        year: 2002,
        primary_image_url: null,
        search_doc_norm: "charizard expedition 4 165 2002",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("charizard 4"),
    limit: 20,
  });

  assert.equal(bareNameAndNumberPrefersOriginalEra[0]?.canonical_slug, "base-4-charizard");

  const tieBreakerResult = buildSearchCardResults({
    canonicalRows: [
      {
        canonical_slug: "neo-1-energy-charge",
        canonical_name: "Energy Charge",
        set_name: "Neo Genesis",
        card_number: "85",
        year: 2000,
        primary_image_url: null,
        search_doc_norm: "energy charge neo genesis 85 2000",
      },
      {
        canonical_slug: "base-90-energy-retrieval",
        canonical_name: "Energy Retrieval",
        set_name: "Base Set",
        card_number: "90",
        year: 1999,
        primary_image_url: null,
        search_doc_norm: "energy retrieval base set 90 1999",
      },
    ],
    aliasRows: [],
    query: normalizeSearchInput("energy"),
    limit: 20,
  });

  assert.equal(tieBreakerResult[0]?.canonical_slug, "neo-1-energy-charge");

  // Reprint regrouping (2026-07-01): ME: Ascended Heroes reprints
  // Surging Sparks Pikachu ex with the SAME name and collector number.
  // A bare-name query ties every printing on score, and the year-DESC
  // tiebreak buried the 2024 original below every 2026 reprint (user
  // report: pulled card missing from the 8-row iOS correction sheet).
  // Same-name+number ties must group at the best member's rank with
  // the original printing first.
  const reprintRows = [
    {
      canonical_slug: "surging-sparks-57-pikachu-ex",
      canonical_name: "Pikachu ex",
      set_name: "Surging Sparks",
      card_number: "57",
      year: 2024,
      primary_image_url: null,
      search_doc_norm: "pikachu ex surging sparks 57 2024",
    },
    {
      canonical_slug: "ascended-heroes-57-pikachu-ex",
      canonical_name: "Pikachu ex",
      set_name: "Ascended Heroes",
      card_number: "57",
      year: 2026,
      primary_image_url: null,
      search_doc_norm: "pikachu ex ascended heroes 57 2026",
    },
    {
      canonical_slug: "ascended-heroes-277-pikachu-ex",
      canonical_name: "Pikachu ex",
      set_name: "Ascended Heroes",
      card_number: "277",
      year: 2026,
      primary_image_url: null,
      search_doc_norm: "pikachu ex ascended heroes 277 2026",
    },
  ];

  const reprintGrouping = buildSearchCardResults({
    canonicalRows: reprintRows,
    aliasRows: [],
    query: normalizeSearchInput("pikachu ex"),
    limit: 20,
  });

  // Without regrouping this was [AH#277, AH#57, SS#57] (year DESC,
  // then slug). The #57 pair collapses to the AH#57 slot, original
  // (2024) printing first; the unshared #277 keeps its own rank.
  assert.deepEqual(
    reprintGrouping.map((row) => row.canonical_slug),
    [
      "ascended-heroes-277-pikachu-ex",
      "surging-sparks-57-pikachu-ex",
      "ascended-heroes-57-pikachu-ex",
    ],
  );

  // Number-in-query path already preferred the older printing via
  // preferOlderExactNumberedMatch — regrouping must not disturb it.
  const reprintWithNumber = buildSearchCardResults({
    canonicalRows: reprintRows,
    aliasRows: [],
    query: normalizeSearchInput("pikachu ex 57"),
    limit: 20,
  });

  assert.equal(reprintWithNumber[0]?.canonical_slug, "surging-sparks-57-pikachu-ex");
  assert.equal(reprintWithNumber[1]?.canonical_slug, "ascended-heroes-57-pikachu-ex");
}
