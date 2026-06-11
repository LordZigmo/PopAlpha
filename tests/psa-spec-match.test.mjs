import assert from "node:assert/strict";

import {
  decideSpecMatch,
  normalizePsaBrandKey,
  normalizePsaCardNumber,
  parsePsaBrand,
  parsePsaVariety,
  resolvePsaSet,
  subjectAgreementScore,
} from "../lib/psa/spec-match.ts";

// Set index fixture mirroring real scan_canonical_set_index rows,
// including the legacy near-duplicate ("BS1" vs "base1") that exists in
// prod card_printings.
const SET_INDEX = [
  { set_code: "base1", set_name: "Base", language: "EN", year_min: 1999, year_max: 1999 },
  { set_code: "BS1", set_name: "Base Set", language: "EN", year_min: 1999, year_max: 1999 },
  { set_code: "base2", set_name: "Jungle", language: "EN", year_min: 1999, year_max: 1999 },
  { set_code: "base2_ja", set_name: "Jungle", language: "JP", year_min: 1997, year_max: 1997 },
  { set_code: "gym2", set_name: "Gym Challenge", language: "EN", year_min: 2000, year_max: 2000 },
  { set_code: "swsh7", set_name: "Evolving Skies", language: "EN", year_min: 2021, year_max: 2021 },
  { set_code: "sv4a_ja", set_name: "Shiny Treasure ex", language: "JP", year_min: 2023, year_max: 2023 },
  { set_code: "svp", set_name: "SV Black Star Promos", language: "EN", year_min: 2023, year_max: 2023 },
  { set_code: "dpp_ja", set_name: "Diamond & Pearl Promos", language: "JP", year_min: 2006, year_max: 2006 },
];

const NO_CURATED = new Map();

// ── normalizePsaBrandKey ──────────────────────────────────────────────
assert.equal(
  normalizePsaBrandKey("  Pokemon  Japanese   SV4a-Shiny Treasure ex "),
  "POKEMON JAPANESE SV4A-SHINY TREASURE EX",
);
assert.equal(normalizePsaBrandKey("POKEMON INT’L TRICK"), "POKEMON INT'L TRICK");

// ── parsePsaBrand ─────────────────────────────────────────────────────
{
  const parsed = parsePsaBrand("POKEMON JAPANESE SV4a-SHINY TREASURE ex");
  assert.equal(parsed.language, "JP");
  assert.deepEqual(parsed.phraseTokens, ["SV4A", "SHINY", "TREASURE", "EX"]);
  assert.ok(parsed.codeCandidates.includes("SV4A"));
}
{
  const parsed = parsePsaBrand("POKEMON SVP EN-SV BLACK STAR PROMO");
  assert.equal(parsed.language, "EN");
  assert.ok(parsed.codeCandidates.includes("SVP"));
  // "EN" is noise; "SV" is mid-phrase pure letters → not a code candidate.
  assert.ok(!parsed.codeCandidates.includes("SV"));
}
{
  const parsed = parsePsaBrand("POKEMON GYM CHALLENGE");
  assert.equal(parsed.language, "EN");
  assert.deepEqual(parsed.phraseTokens, ["GYM", "CHALLENGE"]);
}

// ── resolvePsaSet ─────────────────────────────────────────────────────
// Code + name agreement (modern JP brand) — strongest derived signal.
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON JAPANESE SV4a-SHINY TREASURE ex"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "sv4a_ja");
  assert.equal(resolution?.method, "DERIVED_CODE_NAME");
  assert.equal(resolution?.confidence, 0.95);
}
// Lead-abbreviation code only ("SVP EN-SV..." defeats name equality).
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON SVP EN-SV BLACK STAR PROMO"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "svp");
  assert.equal(resolution?.method, "DERIVED_CODE");
}
// Name equality, language-filtered (EN Jungle, not base2_ja).
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON JUNGLE"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "base2");
  assert.equal(resolution?.method, "DERIVED_NAME");
}
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON JAPANESE JUNGLE"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "base2_ja");
}
// Series-prefix strip variant.
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON SWORD & SHIELD EVOLVING SKIES"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "swsh7");
}
// Generic brand with no unique resolution stays unresolved (the queue).
{
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON JAPANESE PROMO"),
    curatedByKey: NO_CURATED,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution, null);
}
// Curated rows always win.
{
  const curated = new Map([[
    "POKEMON JAPANESE PROMO",
    {
      psa_brand_key: "POKEMON JAPANESE PROMO",
      canonical_set_code: "dpp_ja",
      canonical_set_name: "Diamond & Pearl Promos",
      language: "JP",
      confidence: 1,
      source: "MANUAL",
    },
  ]]);
  const resolution = resolvePsaSet({
    parsed: parsePsaBrand("POKEMON JAPANESE PROMO"),
    curatedByKey: curated,
    setIndex: SET_INDEX,
  });
  assert.equal(resolution?.setCode, "dpp_ja");
  assert.equal(resolution?.method, "CURATED");
  assert.equal(resolution?.confidence, 1);
}

// ── parsePsaVariety ───────────────────────────────────────────────────
{
  const parsed = parsePsaVariety("ILLUSTRATOR", "PIKACHU - HOLO");
  assert.equal(parsed.cleanedSubject, "PIKACHU");
  assert.equal(parsed.finish, "HOLO");
  assert.deepEqual(parsed.unparsedTokens, ["ILLUSTRATOR"]);
}
{
  const parsed = parsePsaVariety("1ST EDITION-HOLO", "CHARIZARD");
  assert.equal(parsed.edition, "FIRST_EDITION");
  assert.equal(parsed.finish, "HOLO");
  assert.deepEqual(parsed.unparsedTokens, []);
}
{
  const parsed = parsePsaVariety("SPECIAL ART RARE", "MEW ex");
  assert.equal(parsed.finish, null);
  assert.equal(parsed.edition, null);
  assert.deepEqual(parsed.descriptorTokens, ["SPECIAL ART RARE"]);
  assert.deepEqual(parsed.unparsedTokens, []);
}
{
  const parsed = parsePsaVariety("POKEMON X VAN GOGH", "PIKACHU/GREY FELT HAT");
  assert.deepEqual(parsed.descriptorTokens, ["POKEMON X VAN GOGH"]);
  assert.deepEqual(parsed.unparsedTokens, []);
}
{
  const parsed = parsePsaVariety("REVERSE FOIL", "SNORLAX");
  assert.equal(parsed.finish, "REVERSE_HOLO");
}
{
  const parsed = parsePsaVariety("MASTER BALL", "RIOLU");
  assert.equal(parsed.stamp, "MASTER_BALL_PATTERN");
}
{
  const parsed = parsePsaVariety("SHADOWLESS", "CHARIZARD-HOLO");
  assert.equal(parsed.stamp, "SHADOWLESS");
}

// ── normalizePsaCardNumber ────────────────────────────────────────────
assert.deepEqual(normalizePsaCardNumber("085"), { raw: "085", zeroStripped: "85" });
assert.deepEqual(normalizePsaCardNumber("044/030"), { raw: "044", zeroStripped: "44" });
assert.deepEqual(normalizePsaCardNumber("TG12"), { raw: "TG12", zeroStripped: "TG12" });
assert.deepEqual(normalizePsaCardNumber(null), { raw: "", zeroStripped: "" });

// ── subjectAgreementScore ─────────────────────────────────────────────
assert.equal(subjectAgreementScore("MEW ex", "Mew ex"), 1);
// Stopwords don't count against exactness.
assert.equal(
  subjectAgreementScore("PIKACHU/GREY FELT HAT", "Pikachu with Grey Felt Hat"),
  1,
);
// True subset (PSA omits a token) scores below exact.
assert.equal(subjectAgreementScore("MEW", "Mew ex"), 0.93);
assert.equal(subjectAgreementScore("SABRINA'S GENGAR", "Sabrina's Gengar"), 1);
assert.equal(subjectAgreementScore("CHARIZARD", "Blastoise"), 0);

// ── decideSpecMatch ───────────────────────────────────────────────────
const MEW_FIELDS = {
  specId: 10041062,
  year: "2023",
  brand: "POKEMON JAPANESE SV4a-SHINY TREASURE ex",
  category: "TCG Cards",
  cardNumber: "347",
  subject: "MEW ex",
  variety: "SPECIAL ART RARE",
};
const SV4A_RESOLUTION = resolvePsaSet({
  parsed: parsePsaBrand(MEW_FIELDS.brand),
  curatedByKey: NO_CURATED,
  setIndex: SET_INDEX,
});
const SV4A_PRINTINGS = [
  {
    id: "printing-mew",
    canonical_slug: "sv4a-ja-347-mew-ex",
    set_code: "sv4a_ja",
    card_number: "347",
    language: "JP",
    finish: "HOLO",
    edition: "UNLIMITED",
    stamp: null,
  },
];
const SV4A_NAMES = new Map([["sv4a-ja-347-mew-ex", "Mew ex"]]);

// Sealed products short-circuit before any set logic.
{
  const decision = decideSpecMatch({
    fields: {
      specId: 7644607,
      year: "2022",
      brand: "POKEMON INT'L TRICK OR TRADE FOIL PACK",
      category: "PACKS",
      cardNumber: "",
      subject: "TRICK OR TRADE",
      variety: "FOIL PACK",
    },
    setResolution: null,
    printings: [],
    canonicalNamesBySlug: new Map(),
  });
  assert.equal(decision.status, "UNMATCHED");
  assert.equal(decision.reason, "NON_CARD_CATEGORY");
}

// Unresolved set queues for curation.
{
  const decision = decideSpecMatch({
    fields: {
      specId: 666080,
      year: "1998",
      brand: "POKEMON JAPANESE PROMO",
      category: "TCG Cards",
      cardNumber: "",
      subject: "PIKACHU - HOLO",
      variety: "ILLUSTRATOR",
    },
    setResolution: null,
    printings: [],
    canonicalNamesBySlug: new Map(),
  });
  assert.equal(decision.status, "UNMATCHED");
  assert.equal(decision.reason, "MISSING_PSA_SET_MAP");
}

// The real Mew ex spec auto-matches at 0.95 (derived set, exact
// number, exact subject, single printing).
{
  const decision = decideSpecMatch({
    fields: MEW_FIELDS,
    setResolution: SV4A_RESOLUTION,
    printings: SV4A_PRINTINGS,
    canonicalNamesBySlug: SV4A_NAMES,
  });
  assert.equal(decision.status, "MATCHED");
  assert.equal(decision.canonicalSlug, "sv4a-ja-347-mew-ex");
  assert.equal(decision.printingId, "printing-mew");
  assert.equal(decision.confidence, 0.95);
  assert.equal(decision.matchType, "SET_NUMBER_SUBJECT_EXACT");
}

// A number hit whose subject disagrees is queued, never matched.
{
  const decision = decideSpecMatch({
    fields: { ...MEW_FIELDS, subject: "CHARIZARD" },
    setResolution: SV4A_RESOLUTION,
    printings: SV4A_PRINTINGS,
    canonicalNamesBySlug: SV4A_NAMES,
  });
  assert.equal(decision.status, "UNMATCHED");
  assert.equal(decision.reason, "SUBJECT_MISMATCH");
}

// Missing card number → proposal only (queued for review).
{
  const decision = decideSpecMatch({
    fields: { ...MEW_FIELDS, cardNumber: "" },
    setResolution: SV4A_RESOLUTION,
    printings: SV4A_PRINTINGS,
    canonicalNamesBySlug: SV4A_NAMES,
  });
  assert.equal(decision.status, "UNMATCHED");
  assert.equal(decision.reason, "NO_CARD_NUMBER_PROPOSED");
  assert.equal(decision.metadata.proposedSlug, "sv4a-ja-347-mew-ex");
}

// Variety axes pick the right printing among siblings.
{
  const printings = [
    {
      id: "printing-unlimited",
      canonical_slug: "base1-4-charizard",
      set_code: "base1",
      card_number: "4",
      language: "EN",
      finish: "HOLO",
      edition: "UNLIMITED",
      stamp: null,
    },
    {
      id: "printing-first-ed",
      canonical_slug: "base1-4-charizard",
      set_code: "base1",
      card_number: "4",
      language: "EN",
      finish: "HOLO",
      edition: "FIRST_EDITION",
      stamp: null,
    },
  ];
  const names = new Map([["base1-4-charizard", "Charizard"]]);
  const resolution = {
    setCode: "base1",
    setName: "Base",
    language: "EN",
    method: "CURATED",
    confidence: 1,
  };
  const firstEd = decideSpecMatch({
    fields: {
      specId: 1,
      year: "1999",
      brand: "POKEMON GAME",
      category: "TCG Cards",
      cardNumber: "4",
      subject: "CHARIZARD",
      variety: "1ST EDITION-HOLO",
    },
    setResolution: resolution,
    printings,
    canonicalNamesBySlug: names,
  });
  assert.equal(firstEd.status, "MATCHED");
  assert.equal(firstEd.printingId, "printing-first-ed");
  assert.equal(firstEd.confidence, 1);

  const unlimited = decideSpecMatch({
    fields: {
      specId: 2,
      year: "1999",
      brand: "POKEMON GAME",
      category: "TCG Cards",
      cardNumber: "4",
      subject: "CHARIZARD",
      variety: "HOLO",
    },
    setResolution: resolution,
    printings,
    canonicalNamesBySlug: names,
  });
  assert.equal(unlimited.status, "MATCHED");
  assert.equal(unlimited.printingId, "printing-unlimited");
}

// Zero-padding differences still match (085 vs 85), slightly discounted.
{
  const printings = [
    {
      id: "printing-vangogh",
      canonical_slug: "svp-85-pikachu-with-grey-felt-hat",
      set_code: "svp",
      card_number: "85",
      language: "EN",
      finish: "HOLO",
      edition: "UNLIMITED",
      stamp: null,
    },
  ];
  const names = new Map([["svp-85-pikachu-with-grey-felt-hat", "Pikachu with Grey Felt Hat"]]);
  const decision = decideSpecMatch({
    fields: {
      specId: 9656727,
      year: "2023",
      brand: "POKEMON SVP EN-SV BLACK STAR PROMO",
      category: "TCG Cards",
      cardNumber: "085",
      subject: "PIKACHU/GREY FELT HAT",
      variety: "POKEMON X VAN GOGH",
    },
    setResolution: {
      setCode: "svp",
      setName: "SV Black Star Promos",
      language: "EN",
      method: "CURATED",
      confidence: 1,
    },
    printings,
    canonicalNamesBySlug: names,
  });
  assert.equal(decision.status, "MATCHED");
  assert.equal(decision.canonicalSlug, "svp-85-pikachu-with-grey-felt-hat");
  // 1.0 (curated set) × 1.0 (stopword-exact subject) × 0.99 (zero-stripped number)
  assert.equal(decision.confidence, 0.99);
}

console.log("psa-spec-match tests passed");
