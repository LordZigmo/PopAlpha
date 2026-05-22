/**
 * Unit tests for lib/jp/translation-match.mjs (rule-based picker).
 *
 * The picker hits Postgres for its lookup, so we stub the sql client
 * here. The stub records the parameter list it was called with so the
 * test can verify both the inputs and the picker's classification of
 * the response into paired / unpaired / ambiguous shapes.
 *
 * Run:
 *   node tests/jp/translation-match.test.mjs
 */

import assert from "node:assert/strict";
import {
  findPairBySetCode,
  deletePairingsForEnSlug,
  PAIRING_SOURCE,
  PAIRING_CONFIDENCE,
  PAIRING_RANK,
} from "../../lib/jp/translation-match.mjs";

// Build a stub sql client that returns the given row for a single
// .query() call. The shape mirrors @vercel/postgres's `sql.query`.
function stubSqlReturning(row, options = {}) {
  const calls = [];
  return {
    async query(text, params) {
      calls.push({ text, params });
      if (typeof options.rowCount === "number") {
        return { rows: row ? [row] : [], rowCount: options.rowCount };
      }
      return { rows: row ? [row] : [] };
    },
    calls,
  };
}

export async function runTranslationMatchTests() {
  // ── Pairing constants ───────────────────────────────────────────────────
  assert.equal(PAIRING_SOURCE, "set_pair");
  assert.equal(PAIRING_CONFIDENCE, 1.0);
  assert.equal(PAIRING_RANK, 0);

  // ── PAIRED: exactly one JP match in the verified set ────────────────────
  {
    const sqlStub = stubSqlReturning({
      set_code_count: 1,
      set_codes: ["base1"],
      en_set_code: "base1",
      jp_set_code: "base1_ja",
      en_set_name: "Base",
      jp_set_name: "拡張パック",
      pair_count: 1,
      match_count: 1,
      jp_slugs: ["expansion-pack-6-charizard-jp"],
    });
    const result = await findPairBySetCode(sqlStub, "base-set-4-charizard");
    assert.equal(result.kind, "paired");
    assert.equal(result.jp_slug, "expansion-pack-6-charizard-jp");
    assert.equal(result.en_set_code, "base1");
    assert.equal(result.jp_set_code, "base1_ja");
    assert.equal(result.en_set_name, "Base");
    assert.equal(result.jp_set_name, "拡張パック");
    // Picker should have passed the EN slug as the sole bind param.
    assert.equal(sqlStub.calls.length, 1);
    assert.deepEqual(sqlStub.calls[0].params, ["base-set-4-charizard"]);
  }

  // ── UNPAIRED: EN set has no verified pair in set_pair_map ───────────────
  // (Common case for EN-exclusive sets like Celebrations.)
  {
    const sqlStub = stubSqlReturning({
      set_code_count: 1,
      set_codes: ["cel25c"],
      en_set_code: "cel25c",
      jp_set_code: null,
      en_set_name: null,
      jp_set_name: null,
      pair_count: 0,
      match_count: 0,
      jp_slugs: null,
    });
    const result = await findPairBySetCode(sqlStub, "celebrations-classic-collection-4-charizard");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_verified_set_pair");
    assert.equal(result.en_set_code, "cel25c");
  }

  // ── UNPAIRED: EN sits in a paired set but no JP card shares its name ────
  // (E.g., Wizards-added EN-only card inside an otherwise-paired vintage set.)
  {
    const sqlStub = stubSqlReturning({
      set_code_count: 1,
      set_codes: ["base1"],
      en_set_code: "base1",
      jp_set_code: "base1_ja",
      en_set_name: "Base",
      jp_set_name: "拡張パック",
      pair_count: 1,
      match_count: 0,
      jp_slugs: [],
    });
    const result = await findPairBySetCode(sqlStub, "base-set-some-en-exclusive-card");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_name_match");
    assert.equal(result.en_set_code, "base1");
    assert.equal(result.jp_set_code, "base1_ja");
  }

  // ── AMBIGUOUS: multiple same-name JP cards in the paired set ────────────
  // (Rare but happens with promos / multi-printings inside one set code.)
  {
    const sqlStub = stubSqlReturning({
      set_code_count: 1,
      set_codes: ["swshp"],
      en_set_code: "swshp",
      jp_set_code: "swshp_ja",
      en_set_name: "SWSH Black Star Promos",
      jp_set_name: "S-P Promos",
      pair_count: 1,
      match_count: 3,
      jp_slugs: [
        "swsh-promo-1-pikachu-jp",
        "swsh-promo-99-pikachu-jp",
        "swsh-promo-250-pikachu-jp",
      ],
    });
    const result = await findPairBySetCode(sqlStub, "swsh-promo-25-pikachu");
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.reason, "multiple_jp_matches");
    assert.equal(result.jp_slugs.length, 3);
    assert.equal(result.en_set_code, "swshp");
    assert.equal(result.jp_set_code, "swshp_ja");
  }

  // ── AMBIGUOUS: canonical_slug spans multiple distinct set_codes ─────────
  // Codex P2 on commit 4def09bc34. Picker must NOT silently pick the
  // lexicographic first set_code when a canonical_card has printings
  // across two or more sets.
  {
    const sqlStub = stubSqlReturning({
      set_code_count: 2,
      set_codes: ["base1", "base4"],
      en_set_code: null,
      jp_set_code: null,
      en_set_name: null,
      jp_set_name: null,
      pair_count: 0,
      match_count: 0,
      jp_slugs: null,
    });
    const result = await findPairBySetCode(sqlStub, "weird-multi-set-card");
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.reason, "multiple_en_set_codes");
    assert.deepEqual(result.en_set_codes, ["base1", "base4"]);
  }

  // ── EMPTY result row (EN slug not found at all) ─────────────────────────
  {
    const sqlStub = stubSqlReturning(null);
    const result = await findPairBySetCode(sqlStub, "no-such-slug");
    assert.equal(result.kind, "unpaired");
    assert.equal(result.reason, "no_verified_set_pair");
    assert.equal(result.en_set_code, null);
  }

  // ── deletePairingsForEnSlug delegates to a single DELETE ────────────────
  {
    const sqlStub = stubSqlReturning(null, { rowCount: 1 });
    const deleted = await deletePairingsForEnSlug(sqlStub, "base-set-some-slug");
    assert.equal(deleted, 1);
    assert.equal(sqlStub.calls.length, 1);
    assert.deepEqual(sqlStub.calls[0].params, ["base-set-some-slug"]);
    assert.match(sqlStub.calls[0].text, /delete from card_translations where en_slug = \$1/i);
  }
}

// Auto-execute when invoked directly.
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTranslationMatchTests().then(
    () => console.log("translation-match tests passed"),
    (e) => { console.error(e); process.exit(1); },
  );
}
