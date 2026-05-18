/**
 * Unit tests for lib/jp/translation-match.mjs.
 *
 * Pinned cases motivated by the diagnosis in
 * plans/we-need-to-work-cozy-shannon.md — every case here corresponds
 * to a real-world pairing scenario the new gate must handle:
 *
 *   - STRICT_MATCH happy path:     "Eevee" ↔ "Eevee"
 *   - Variant-suffix tolerance:    "Charizard ex" ↔ "Charizard EX"
 *   - Different species reject:    "Charizard" ↔ "Charmeleon" (evolution share)
 *   - Glossary fallback:           "Pikachu" with diverging EN-form, native populated
 *   - Null-gate path:              no name on either side
 *   - Threshold matrix:            STRICT+number passes at cos=0.78;
 *                                  STRICT without number rejected at cos=0.78;
 *                                  STRICT without number accepts at cos=0.86
 *
 * Run directly:
 *   node tests/jp/translation-match.test.mjs
 *
 * Wired into npm test:translation-match (see package.json).
 */

import assert from "node:assert/strict";
import {
  nameGate,
  cardNumberMatch,
  normalizeForStrictMatch,
  resolveCosineFloors,
  pickPairings,
  THRESHOLDS,
} from "../../lib/jp/translation-match.mjs";

function eevee() {
  return { canonical_name: "Eevee", canonical_name_native: null, card_number: "75", slug: "aquapolis-75-eevee" };
}
// Factory: build a JP candidate row with overridable slug/card_number/cosine.
// pickPairings reads jp_slug from candidate.card.slug, so the slug field on
// the card object is the authoritative one — keep them in sync.
function jpCand({ slug, cosine, card_number = "133" }) {
  return {
    jp_slug: slug,
    cosine,
    card: {
      slug,
      canonical_name: "Eevee",
      canonical_name_native: "イーブイ",
      card_number,
    },
  };
}

export function runTranslationMatchTests() {
  // ── normalizeForStrictMatch ──────────────────────────────────────────────
  assert.equal(normalizeForStrictMatch("Eevee"), "eevee");
  assert.equal(normalizeForStrictMatch("  Charizard ex "), "charizard");
  assert.equal(normalizeForStrictMatch("Charizard EX"), "charizard");
  assert.equal(normalizeForStrictMatch("Pikachu V"), "pikachu");
  assert.equal(normalizeForStrictMatch("Pikachu VMAX"), "pikachu");
  assert.equal(normalizeForStrictMatch("Pikachu VSTAR"), "pikachu");
  // Mid-word "ex" must NOT be stripped (e.g., "Mexico" or "Extra")
  assert.equal(normalizeForStrictMatch("Hex Maniac"), "hex maniac");
  // null/undefined safe
  assert.equal(normalizeForStrictMatch(null), "");
  assert.equal(normalizeForStrictMatch(undefined), "");

  // ── nameGate: STRICT_MATCH ──────────────────────────────────────────────
  assert.equal(nameGate({ canonical_name: "Eevee" }, { canonical_name: "Eevee" }), "STRICT_MATCH");
  assert.equal(nameGate({ canonical_name: "Charizard ex" }, { canonical_name: "Charizard EX" }), "STRICT_MATCH");
  assert.equal(nameGate({ canonical_name: "Pikachu V" }, { canonical_name: "Pikachu V" }), "STRICT_MATCH");

  // ── nameGate: GLOSSARY_MATCH fallback (en canonical_name diverges, JP native populated) ──
  // The static glossary maps "Pikachu" → "ピカチュウ"; the JP candidate's
  // canonical_name_native contains "ピカチュウ" but the EN-form canonical_name
  // is something the importer didn't normalize.
  assert.equal(
    nameGate(
      { canonical_name: "Pikachu" },
      { canonical_name: "Pika (vintage card)", canonical_name_native: "ピカチュウ ポケモン" },
    ),
    "GLOSSARY_MATCH",
  );

  // ── nameGate: MISS — glossary disagrees explicitly ──────────────────────
  // EN: Charizard → リザードン. JP native: リザード (Charmeleon). Different species.
  // The glossary has a strong opinion that disagrees, so we reject even at
  // high cosine. (Substring guard: リザード IS a substring of リザードン so
  // the includes check naively would have passed in the OTHER direction;
  // here we're asserting the strict direction — expected JP "リザードン"
  // is NOT contained in actual JP "リザード", so this is a MISS.)
  assert.equal(
    nameGate(
      { canonical_name: "Charizard" },
      { canonical_name: "Charmeleon", canonical_name_native: "リザード" },
    ),
    "MISS",
  );

  // ── nameGate: null — no signal either way ───────────────────────────────
  // EN species not in glossary AND JP native missing → caller falls back to
  // NO_GATE_FLOOR_COSINE. Use a fictional Pokemon name not in POKEMON_NAMES
  // to avoid future-proofing fragility if the glossary expands.
  assert.equal(
    nameGate(
      { canonical_name: "Zzznotreal" },
      { canonical_name: "Differently Named", canonical_name_native: null },
    ),
    null,
  );

  // EN species in glossary, JP native missing → still null (can't gate).
  assert.equal(
    nameGate(
      { canonical_name: "Pikachu" },
      { canonical_name: "PikaDifferent", canonical_name_native: null },
    ),
    null,
  );

  // ── cardNumberMatch ──────────────────────────────────────────────────────
  assert.equal(cardNumberMatch({ card_number: "4" }, { card_number: "4" }), true);
  assert.equal(cardNumberMatch({ card_number: "058/102" }, { card_number: "58" }), true);
  assert.equal(cardNumberMatch({ card_number: "001" }, { card_number: "1" }), true);
  assert.equal(cardNumberMatch({ card_number: "75" }, { card_number: "133" }), false);
  assert.equal(cardNumberMatch({ card_number: null }, { card_number: "1" }), false);
  assert.equal(cardNumberMatch({ card_number: "1" }, { card_number: "" }), false);

  // ── resolveCosineFloors matrix ──────────────────────────────────────────
  assert.deepEqual(
    resolveCosineFloors("STRICT_MATCH", true),
    {
      primary: THRESHOLDS.STRICT_PRIMARY_COSINE_WITH_NUMBER,
      alt: THRESHOLDS.STRICT_ALT_COSINE_WITH_NUMBER,
    },
  );
  assert.deepEqual(
    resolveCosineFloors("STRICT_MATCH", false),
    {
      primary: THRESHOLDS.STRICT_PRIMARY_COSINE_NO_NUMBER,
      alt: THRESHOLDS.STRICT_ALT_COSINE_NO_NUMBER,
    },
  );
  assert.deepEqual(
    resolveCosineFloors("GLOSSARY_MATCH", false),
    { primary: THRESHOLDS.GLOSSARY_PRIMARY_COSINE, alt: THRESHOLDS.GLOSSARY_ALT_COSINE },
  );
  assert.deepEqual(
    resolveCosineFloors(null, true),
    { primary: THRESHOLDS.NO_GATE_FLOOR_COSINE, alt: THRESHOLDS.NO_GATE_FLOOR_COSINE },
  );
  // MISS: both floors are Infinity (unreachable -> reject)
  const missFloors = resolveCosineFloors("MISS", true);
  assert.equal(missFloors.primary, Infinity);
  assert.equal(missFloors.alt, Infinity);

  // ── pickPairings: STRICT+number passes at 0.78 (clears 0.75 primary) ────
  {
    const en = eevee();
    const cand = jpCand({ slug: "evolution-jp-100-eevee", cosine: 0.78, card_number: "75" });
    const pairings = pickPairings(en, [cand]);
    assert.equal(pairings.length, 1);
    assert.equal(pairings[0].rank, 0);
    assert.equal(pairings[0].jp_slug, "evolution-jp-100-eevee");
    assert.equal(pairings[0].numbersMatch, true);
    assert.equal(pairings[0].gateResult, "STRICT_MATCH");
  }

  // ── pickPairings: STRICT without number REJECTED at 0.78 (alt floor is 0.80) ──
  {
    const en = eevee();
    const cand = jpCand({ slug: "evolution-jp-100-eevee", cosine: 0.78, card_number: "999" });
    const pairings = pickPairings(en, [cand]);
    assert.equal(pairings.length, 0, "STRICT-no-number at 0.78 should fail the 0.80 alt floor");
  }

  // ── pickPairings: STRICT without number ACCEPTED at 0.86 (clears 0.85 primary) ──
  {
    const en = eevee();
    const cand = jpCand({ slug: "evolution-jp-100-eevee", cosine: 0.86, card_number: "999" });
    const pairings = pickPairings(en, [cand]);
    assert.equal(pairings.length, 1);
    assert.equal(pairings[0].rank, 0);
    assert.equal(pairings[0].gateResult, "STRICT_MATCH");
    assert.equal(pairings[0].numbersMatch, false);
  }

  // ── pickPairings: MISS rejected even at near-perfect cosine ─────────────
  {
    const en = { canonical_name: "Charizard", canonical_name_native: null, card_number: "4", slug: "base-set-4-charizard" };
    const cand = {
      jp_slug: "wrong-jp",
      cosine: 0.99,
      card: { canonical_name: "Charmeleon", canonical_name_native: "リザード", card_number: "4", slug: "wrong-jp" },
    };
    const pairings = pickPairings(en, [cand]);
    assert.equal(pairings.length, 0, "MISS gate should reject even at cos=0.99");
  }

  // ── pickPairings: ranks ordered + alt cap respected ─────────────────────
  {
    const en = eevee();
    const cands = [
      jpCand({ slug: "primary", cosine: 0.91, card_number: "75" }),
      jpCand({ slug: "alt1",    cosine: 0.84, card_number: "200" }),
      jpCand({ slug: "alt2",    cosine: 0.82, card_number: "300" }),
      jpCand({ slug: "dropped", cosine: 0.81, card_number: "400" }),
    ];
    const pairings = pickPairings(en, cands);
    // primary clears STRICT+number primary floor (0.75); the three remaining
    // candidates clear STRICT no-number alt floor (0.80). altRankMax=2 caps
    // alts at two.
    assert.equal(pairings.length, 3);
    assert.equal(pairings[0].rank, 0);
    assert.equal(pairings[0].jp_slug, "primary");
    assert.equal(pairings[1].rank, 1);
    assert.equal(pairings[2].rank, 2);
    assert.ok(
      ["alt1", "alt2"].includes(pairings[1].jp_slug),
      "alt rank 1 should be one of the alternates",
    );
  }

  // ── pickPairings: primary needs raw cosine ≥ floor (boost doesn't help) ──
  // Codex P2 lesson from PR #67: numberBoost is an ordering tiebreak only.
  // A 0.74 candidate with number match has score 0.76 but cosine 0.74 — below
  // STRICT+number primary floor 0.75. Must NOT promote to rank=0.
  {
    const en = eevee();
    const cands = [
      // raw cosine 0.74, with number → score 0.76, but cosine fails primary 0.75
      jpCand({ slug: "tricky", cosine: 0.74, card_number: "75" }),
    ];
    const pairings = pickPairings(en, cands);
    // 0.74 < STRICT_ALT_COSINE_WITH_NUMBER (0.70)? No, 0.74 > 0.70 so
    // it clears the ALT floor, but PRIMARY floor with number is 0.75 → 0.74
    // fails primary. No primary found → return [].
    assert.equal(pairings.length, 0, "raw cosine 0.74 must not clear primary 0.75 even with number boost");
  }

  // ── pickPairings: gateResult/numbersMatch/reason exposed for logging ────
  {
    const en = eevee();
    const cand = jpCand({ slug: "evolution-jp-100-eevee", cosine: 0.91, card_number: "75" });
    const [primary] = pickPairings(en, [cand]);
    assert.equal(primary.gateResult, "STRICT_MATCH");
    assert.equal(primary.numbersMatch, true);
    assert.match(primary.reason, /STRICT_MATCH\+number cos=0\.9100/);
  }

  // ── pickPairings: no early break — STRICT+number candidate sorted below
  //    a cluster of STRICT-no-number candidates is still considered as primary.
  //    Codex P2 on PR #109. Scenario:
  //      A/B/C/D: STRICT_MATCH, numbers DIFFER, cosine 0.80-0.84
  //               → clear alt 0.80, FAIL primary 0.85
  //      E:       STRICT_MATCH + number match, cosine 0.75
  //               → clears alt 0.70, CLEARS primary 0.75
  //    With the old `accepted.length > altRankMax + 1 break`, A-D would
  //    fill `accepted` (4 items > 3 → break) and E never seen; the primary
  //    search would fail and the function would return []. After the fix,
  //    E lands in accepted and becomes rank=0.
  {
    const en = eevee();
    const cands = [
      jpCand({ slug: "noNum1", cosine: 0.84, card_number: "201" }),
      jpCand({ slug: "noNum2", cosine: 0.83, card_number: "202" }),
      jpCand({ slug: "noNum3", cosine: 0.82, card_number: "203" }),
      jpCand({ slug: "noNum4", cosine: 0.80, card_number: "204" }),
      // STRICT+number candidate — score 0.77, sorts 5th, but is a valid primary.
      jpCand({ slug: "rescue", cosine: 0.75, card_number: "75" }),
    ];
    const pairings = pickPairings(en, cands);
    assert.equal(pairings.length, 3, "should return rescue as primary + 2 alts");
    assert.equal(pairings[0].rank, 0);
    assert.equal(pairings[0].jp_slug, "rescue", "lower-cosine STRICT+number must be promoted to primary");
    assert.equal(pairings[0].numbersMatch, true);
  }
}

// Auto-execute when invoked directly: `node tests/jp/translation-match.test.mjs`
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTranslationMatchTests();
  console.log("translation-match tests passed");
}
