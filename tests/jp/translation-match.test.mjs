/**
 * Unit tests for rule-based EN <-> JP translation pairing.
 *
 * Run:
 *   node tests/jp/translation-match.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildTranslationMatchCatalog,
  findPairBySetCodeInCatalog,
  deletePairingsForEnSlug,
  upsertPrimaryPairing,
  PAIRING_SOURCE,
  PAIRING_CONFIDENCE,
  PAIRING_RANK,
} from "../../lib/jp/translation-match.mjs";
import {
  AUTO_VERIFY_PCT,
  buildSetPairMapRows,
} from "../../lib/jp/set-pair-map.mjs";

function baseCatalog() {
  return buildTranslationMatchCatalog({
    canonicalCards: [
      { slug: "base-set-4-charizard", language: "EN", canonical_name: "Charizard" },
      { slug: "celebrations-classic-collection-4-charizard", language: "EN", canonical_name: "Charizard" },
      { slug: "base-set-some-en-exclusive-card", language: "EN", canonical_name: "EN Exclusive" },
      { slug: "swsh-promo-25-pikachu", language: "EN", canonical_name: "Pikachu" },
      { slug: "weird-multi-set-card", language: "EN", canonical_name: "Mew" },
      { slug: "expansion-pack-6-charizard-jp", language: "JP", canonical_name: "charizard" },
      { slug: "swsh-promo-1-pikachu-jp", language: "JP", canonical_name: "Pikachu" },
      { slug: "swsh-promo-99-pikachu-jp", language: "JP", canonical_name: "Pikachu" },
      { slug: "rocket-gang-mew-jp", language: "JP", canonical_name: "Mew" },
    ],
    cardPrintings: [
      { canonical_slug: "base-set-4-charizard", set_code: "base1" },
      { canonical_slug: "base-set-4-charizard", set_code: "base1" },
      { canonical_slug: "celebrations-classic-collection-4-charizard", set_code: "cel25c" },
      { canonical_slug: "base-set-some-en-exclusive-card", set_code: "base1" },
      { canonical_slug: "swsh-promo-25-pikachu", set_code: "swshp" },
      { canonical_slug: "weird-multi-set-card", set_code: "base1" },
      { canonical_slug: "weird-multi-set-card", set_code: "base4" },
      { canonical_slug: "expansion-pack-6-charizard-jp", set_code: "base1_ja" },
      { canonical_slug: "swsh-promo-1-pikachu-jp", set_code: "swshp_ja" },
      { canonical_slug: "swsh-promo-99-pikachu-jp", set_code: "swshp_ja" },
      { canonical_slug: "rocket-gang-mew-jp", set_code: "base4_ja" },
    ],
    setPairs: [
      {
        en_set_code: "base1",
        jp_set_code: "base1_ja",
        en_set_name: "Base",
        jp_set_name: "Expansion Pack",
        verified: true,
        source: "auto",
      },
      {
        en_set_code: "swshp",
        jp_set_code: "swshp_ja",
        en_set_name: "SWSH Black Star Promos",
        jp_set_name: "S-P Promos",
        verified: true,
        source: "auto",
      },
      {
        en_set_code: "cel25c",
        jp_set_code: "cel25c_ja",
        verified: false,
        source: "auto",
      },
    ],
  });
}

function createSupabaseStub(responses) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, ops: [] };
      calls.push(call);
      return {
        delete(options) {
          call.ops.push(["delete", options]);
          return this;
        },
        upsert(row, options) {
          call.ops.push(["upsert", row, options]);
          return this;
        },
        eq(column, value) {
          call.ops.push(["eq", column, value]);
          return this;
        },
        neq(column, value) {
          call.ops.push(["neq", column, value]);
          return this;
        },
        select(columns) {
          call.ops.push(["select", columns]);
          return this;
        },
        then(resolve, reject) {
          const response = responses.shift() ?? { data: [], count: 0, error: null };
          return Promise.resolve(response).then(resolve, reject);
        },
      };
    },
  };
}

export async function runTranslationMatchTests() {
  assert.equal(PAIRING_SOURCE, "set_pair");
  assert.equal(PAIRING_CONFIDENCE, 1.0);
  assert.equal(PAIRING_RANK, 0);
  assert.equal(AUTO_VERIFY_PCT, 0.50);

  {
    const rows = buildSetPairMapRows({
      canonicalCards: [
        { slug: "base-set-4-charizard", language: "EN", canonical_name: "Charizard", set_name: "Base" },
        { slug: "base-set-58-pikachu", language: "EN", canonical_name: "Pikachu", set_name: "Base" },
        { slug: "expansion-pack-6-charizard-jp", language: "JP", canonical_name: "charizard", set_name: "Expansion Pack" },
      ],
      cardPrintings: [
        { canonical_slug: "base-set-4-charizard", set_code: "base1" },
        { canonical_slug: "base-set-58-pikachu", set_code: "base1" },
        { canonical_slug: "expansion-pack-6-charizard-jp", set_code: "base1_ja" },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].en_set_code, "base1");
    assert.equal(rows[0].jp_set_code, "base1_ja");
    assert.equal(rows[0].en_card_count, 2);
    assert.equal(rows[0].jp_card_count, 1);
    assert.equal(rows[0].name_match_count, 1);
    assert.equal(rows[0].name_match_pct, 0.5);
    assert.equal(rows[0].verified, true);
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "base-set-4-charizard");
    assert.equal(result.kind, "paired");
    assert.equal(result.jp_slug, "expansion-pack-6-charizard-jp");
    assert.equal(result.en_set_code, "base1");
    assert.equal(result.jp_set_code, "base1_ja");
    assert.equal(result.en_set_name, "Base");
    assert.equal(result.jp_set_name, "Expansion Pack");
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "celebrations-classic-collection-4-charizard");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_verified_set_pair");
    assert.equal(result.en_set_code, "cel25c");
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "base-set-some-en-exclusive-card");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_name_match");
    assert.equal(result.en_set_code, "base1");
    assert.equal(result.jp_set_code, "base1_ja");
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "swsh-promo-25-pikachu");
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.reason, "multiple_jp_matches");
    assert.deepEqual(result.jp_slugs, [
      "swsh-promo-1-pikachu-jp",
      "swsh-promo-99-pikachu-jp",
    ]);
    assert.equal(result.en_set_code, "swshp");
    assert.equal(result.jp_set_code, "swshp_ja");
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "weird-multi-set-card");
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.reason, "multiple_en_set_codes");
    assert.deepEqual(result.en_set_codes, ["base1", "base4"]);
  }

  {
    const result = findPairBySetCodeInCatalog(baseCatalog(), "no-such-slug");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_verified_set_pair");
    assert.equal(result.en_set_code, null);
  }

  {
    const supabase = createSupabaseStub([{ count: 1, error: null }]);
    const deleted = await deletePairingsForEnSlug(supabase, "base-set-some-slug");
    assert.equal(deleted, 1);
    assert.deepEqual(supabase.calls, [
      {
        table: "card_translations",
        ops: [
          ["delete", { count: "exact" }],
          ["eq", "en_slug", "base-set-some-slug"],
          // Scoped to auto-generated rows so manual overrides survive the cron.
          ["eq", "source", "set_pair"],
        ],
      },
    ]);
  }

  {
    const supabase = createSupabaseStub([
      { count: 1, error: null },
      { data: [{ en_slug: "base-set-4-charizard" }], error: null },
    ]);
    const written = await upsertPrimaryPairing(
      supabase,
      "base-set-4-charizard",
      "expansion-pack-6-charizard-jp",
    );
    assert.equal(written, 1);
    assert.equal(supabase.calls.length, 2);
    assert.deepEqual(supabase.calls[0].ops, [
      ["delete", { count: "exact" }],
      ["eq", "en_slug", "base-set-4-charizard"],
      ["neq", "jp_slug", "expansion-pack-6-charizard-jp"],
      // Stale-delete never clobbers a manual override.
      ["eq", "source", "set_pair"],
    ]);
    assert.equal(supabase.calls[1].table, "card_translations");
    assert.equal(supabase.calls[1].ops[0][0], "upsert");
    assert.equal(supabase.calls[1].ops[0][1].source, "set_pair");
    assert.equal(supabase.calls[1].ops[0][2].onConflict, "en_slug,jp_slug");
    assert.deepEqual(supabase.calls[1].ops[1], ["select", "en_slug"]);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTranslationMatchTests().then(
    () => console.log("translation-match tests passed"),
    (e) => { console.error(e); process.exit(1); },
  );
}
