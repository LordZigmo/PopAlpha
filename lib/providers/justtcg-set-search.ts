function normalizeForSearch(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildJustTcgSetSearchTerms(setName: string, setCode: string | null = null): string[] {
  const terms = new Set<string>();
  const trimmed = setName.trim();
  const normalizedAscii = normalizeForSearch(trimmed);

  if (trimmed) terms.add(trimmed);
  if (normalizedAscii && normalizedAscii !== trimmed) terms.add(normalizedAscii);

  const andExpanded = normalizedAscii.replace(/&/g, " and ").replace(/\s+/g, " ").trim();
  if (andExpanded) terms.add(andExpanded);

  const punctuationCollapsed = normalizedAscii
    .replace(/&/g, " ")
    .replace(/[—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (punctuationCollapsed) terms.add(punctuationCollapsed);

  const punctuationRemoved = normalizedAscii
    .replace(/[&—–-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (punctuationRemoved) terms.add(punctuationRemoved);

  const promoExpanded = andExpanded
    .replace(/^DP\b/i, "Diamond and Pearl")
    .replace(/^BW\b/i, "Black and White")
    .replace(/^SWSH\b/i, "Sword and Shield")
    .replace(/^SM\b/i, "Sun and Moon")
    .replace(/^SVP\b/i, "Scarlet and Violet")
    .replace(/^XY\b/i, "XY")
    .replace(/\bBlack Star Promos\b/i, "Promos")
    .replace(/\s+/g, " ")
    .trim();
  if (promoExpanded) terms.add(promoExpanded);

  if (/^Wizards Black Star Promos$/i.test(normalizedAscii)) terms.add("WoTC Promo");
  if (/^Nintendo Black Star Promos$/i.test(normalizedAscii)) terms.add("Nintendo Promos");
  if (/^HS[—–-]/i.test(normalizedAscii)) terms.add(normalizedAscii.replace(/^HS[—–-]\s*/i, "").trim());
  if (/^HeartGold\s*&\s*SoulSilver$/i.test(normalizedAscii)) terms.add("HeartGold SoulSilver");

  if (/^Expedition Base Set$/i.test(normalizedAscii)) terms.add("Expedition");
  if (/^Pokemon GO$/i.test(normalizedAscii)) terms.add("Pokemon GO");

  switch ((setCode ?? "").trim().toLowerCase()) {
    case "ecard1":
      terms.add("Expedition");
      break;
    case "ecard2":
      terms.add("Aquapolis");
      break;
    case "ecard3":
      terms.add("Skyridge");
      break;
    case "pgo":
      terms.add("Pokemon GO");
      break;
    case "np":
      terms.add("Nintendo Promos");
      break;
    default:
      break;
  }

  return Array.from(terms).filter(Boolean);
}
