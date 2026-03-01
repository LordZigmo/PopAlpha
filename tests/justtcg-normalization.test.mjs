import assert from "node:assert/strict";

function normalizeCardNumber(raw) {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  return trimmed;
}

function normalizeMatchingCardNumber(raw) {
  const normalized = normalizeCardNumber(raw);
  const promoMatch = normalized.match(/^([A-Za-z]+)(\d+)$/);
  if (promoMatch) {
    return `${promoMatch[1].toUpperCase()}${String(parseInt(promoMatch[2], 10))}`;
  }
  if (/^[A-Za-z]+$/.test(normalized)) return normalized.toUpperCase();
  return normalized;
}

function mapJustTcgPrinting(printing) {
  const p = printing.toLowerCase().trim();
  if (p.includes("reverse")) return "REVERSE_HOLO";
  if (p.includes("cosmos")) return "HOLO";
  if (p.includes("holo")) return "HOLO";
  return "NON_HOLO";
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toStampToken(value) {
  return normalizeName(value).replace(/\s+/g, "_").toUpperCase();
}

function parsePatternStamp(name) {
  const parentheticalMatch = name.match(/\(([^()]+)\)\s*$/u);
  if (parentheticalMatch?.[1]) {
    const parenthetical = normalizeName(parentheticalMatch[1]);
    if (parenthetical === "poke ball") return "POKE_BALL_PATTERN";
    if (parenthetical === "master ball") return "MASTER_BALL_PATTERN";
    if (parenthetical === "energy symbol pattern") return "ENERGY_SYMBOL_PATTERN";
    return parenthetical ? parenthetical.replace(/\s+/g, "_").toUpperCase() : null;
  }
  const normalized = normalizeName(name);
  if (normalized.includes("master ball")) return "MASTER_BALL_PATTERN";
  if (normalized.includes("poke ball")) return "POKE_BALL_PATTERN";
  if (normalized.includes("energy symbol pattern")) return "ENERGY_SYMBOL_PATTERN";
  return null;
}

function stripPatternSuffix(name) {
  return name
    .replace(/\s*\([^()]+\)\s*$/u, "")
    .replace(/\s+(?:Poke Ball|Master Ball|Energy Symbol Pattern)\s*$/iu, "")
    .trim();
}

export function runJustTcgNormalizationTests() {
  assert.equal(normalizeCardNumber("123/193"), "123");
  assert.equal(normalizeCardNumber("004/193"), "4");
  assert.equal(normalizeCardNumber("#123"), "123");
  assert.equal(normalizeCardNumber("001"), "1");
  assert.equal(normalizeCardNumber("0"), "0");
  assert.equal(normalizeCardNumber("SWSH001"), "SWSH001");

  assert.equal(normalizeMatchingCardNumber("BW004"), "BW4");
  assert.equal(normalizeMatchingCardNumber("BW04"), "BW4");
  assert.equal(normalizeMatchingCardNumber("BW4"), "BW4");
  assert.equal(normalizeMatchingCardNumber("DP01"), "DP1");
  assert.equal(normalizeMatchingCardNumber("SWSH001"), "SWSH1");
  assert.equal(normalizeMatchingCardNumber("XY01"), "XY1");

  assert.equal(mapJustTcgPrinting("Normal"), "NON_HOLO");
  assert.equal(mapJustTcgPrinting("Holofoil"), "HOLO");
  assert.equal(mapJustTcgPrinting("Reverse Holofoil"), "REVERSE_HOLO");
  assert.equal(mapJustTcgPrinting("Cosmos Holofoil"), "HOLO");
  assert.equal(mapJustTcgPrinting("Reverse Cosmos Holofoil"), "REVERSE_HOLO");
  assert.equal(mapJustTcgPrinting(""), "NON_HOLO");

  assert.equal(parsePatternStamp("Pikachu ex (Poke Ball)"), "POKE_BALL_PATTERN");
  assert.equal(parsePatternStamp("Pikachu ex (Master Ball)"), "MASTER_BALL_PATTERN");
  assert.equal(parsePatternStamp("Erika's Oddish (Energy Symbol Pattern)"), "ENERGY_SYMBOL_PATTERN");
  assert.equal(parsePatternStamp("Team Rocket's Diglett (Team Rocket)"), "TEAM_ROCKET");
  assert.equal(parsePatternStamp("Hitmontop - 102/217 (Dusk Ball)"), "DUSK_BALL");
  assert.equal(parsePatternStamp("Pikachu ex"), null);

  assert.equal(stripPatternSuffix("Pikachu ex (Poke Ball)"), "Pikachu ex");
  assert.equal(stripPatternSuffix("Pikachu ex (Master Ball)"), "Pikachu ex");
  assert.equal(stripPatternSuffix("Erika's Oddish (Energy Symbol Pattern)"), "Erika's Oddish");
  assert.equal(stripPatternSuffix("Team Rocket's Diglett (Team Rocket)"), "Team Rocket's Diglett");
}
