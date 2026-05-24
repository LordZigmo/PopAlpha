import { normalizePairingName } from "./pairing-catalog.mjs";

export const AUTO_VERIFY_PCT = 0.50;

function getOrCreateSet(map, setCode, setName) {
  let entry = map.get(setCode);
  if (!entry) {
    entry = {
      setCode,
      setName: setName ?? null,
      slugs: new Set(),
      namesBySlug: new Map(),
      nameKeys: new Set(),
    };
    map.set(setCode, entry);
  } else if (!entry.setName && setName) {
    entry.setName = setName;
  }
  return entry;
}

export function buildSetPairMapRows({
  canonicalCards,
  cardPrintings,
  autoVerifyPct = AUTO_VERIFY_PCT,
}) {
  const cardsBySlug = new Map();
  for (const card of canonicalCards) {
    cardsBySlug.set(card.slug, card);
  }

  const enSets = new Map();
  const jpSets = new Map();

  for (const printing of cardPrintings) {
    if (!printing.set_code) continue;
    const card = cardsBySlug.get(printing.canonical_slug);
    if (!card || (card.language !== "EN" && card.language !== "JP")) continue;

    const target = card.language === "EN" ? enSets : jpSets;
    const entry = getOrCreateSet(target, printing.set_code, card.set_name);
    const nameKey = normalizePairingName(card.canonical_name);
    entry.slugs.add(card.slug);
    entry.namesBySlug.set(card.slug, nameKey);
    if (nameKey) entry.nameKeys.add(nameKey);
  }

  const rows = [];
  for (const [enSetCode, enSet] of [...enSets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const jpSetCode = `${enSetCode}_ja`;
    const jpSet = jpSets.get(jpSetCode);
    if (!jpSet) continue;

    let nameMatchCount = 0;
    for (const enSlug of enSet.slugs) {
      const nameKey = enSet.namesBySlug.get(enSlug);
      if (nameKey && jpSet.nameKeys.has(nameKey)) nameMatchCount += 1;
    }

    const enCardCount = enSet.slugs.size;
    const pct = enCardCount > 0 ? nameMatchCount / enCardCount : 0;
    rows.push({
      en_set_code: enSetCode,
      jp_set_code: jpSetCode,
      en_set_name: enSet.setName,
      jp_set_name: jpSet.setName,
      en_card_count: enCardCount,
      jp_card_count: jpSet.slugs.size,
      name_match_count: nameMatchCount,
      name_match_pct: pct,
      verified: pct >= autoVerifyPct,
      source: "auto",
    });
  }

  return rows;
}
