export type PriceChartingMatchStatus = "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED";

export type PriceChartingProductForMatch = {
  product_id: string;
  product_name: string;
  console_name: string | null;
  genre?: string | null;
};

export type PriceChartingCanonicalCardForMatch = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  language: string | null;
};

export type PriceChartingPrintingForMatch = {
  id: string;
  canonical_slug: string;
  language: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

export type PriceChartingMatchDecision = {
  productId: string;
  canonicalSlug: string | null;
  printingId: string | null;
  matchStatus: PriceChartingMatchStatus;
  matchType: string | null;
  matchConfidence: number | null;
  matchReason: string | null;
  identity: Record<string, unknown>;
};

type Candidate = {
  card: PriceChartingCanonicalCardForMatch;
  nameScore: number;
  setScore: number;
};

const VARIANT_REVIEW_PATTERNS = [
  /\b1st\s*edition\b/i,
  /\bfirst\s*edition\b/i,
  /\bshadowless\b/i,
  /\bmaster\s*ball\b/i,
  /\bpoke\s*ball\b/i,
  /\bstaff\b/i,
  /\bprerelease\b/i,
  /\bpromo\b/i,
  /\bstamped\b/i,
  /\bjumbo\b/i,
  /\bcosmos?\s*holo\b/i,
  /\bcracked\s*ice\b/i,
  /\bgame\s*stop\b/i,
  /\bgamestop\b/i,
  /\beb\s*games\b/i,
  /\bprize\s*pack\b/i,
  /\bleague\b/i,
  /\bchampionships?\b/i,
  /\bprofessor\s*program\b/i,
];

const SAFE_BRACKETED_VARIANT_TOKENS = new Set([
  "foil",
  "holo",
  "non holo",
  "nonholo",
  "reverse foil",
  "reverse holo",
]);

const NON_ENGLISH_SET_PATTERNS = [
  /\bjapanese\b/i,
  /\bkorean\b/i,
  /\bchinese\b/i,
  /\bthai\b/i,
  /\bindonesian\b/i,
  /\bfrench\b/i,
  /\bgerman\b/i,
  /\bitalian\b/i,
  /\bspanish\b/i,
  /\bportuguese\b/i,
  /\brussian\b/i,
  /\bdutch\b/i,
  /\bpolish\b/i,
  /\btaiwan\b/i,
  /\bhong\s*kong\b/i,
];

const NON_TCG_PRODUCT_FAMILY_PATTERNS = [
  /\btopps\b/i,
  /\bkfc\b/i,
  /\bmovie\b/i,
  /\bsticker\b/i,
  /\bstickers\b/i,
  /\bcarddass\b/i,
  /\bbandai\b/i,
];

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizePriceChartingMatchText(value: string | null | undefined): string {
  return stripDiacritics(String(value ?? ""))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePriceChartingCardNumber(value: string | null | undefined): string | null {
  const normalized = normalizePriceChartingMatchText(value).replace(/\s+/g, "");
  if (!normalized) return null;
  const numeric = normalized.match(/^0*(\d+)$/);
  if (numeric) return numeric[1] || "0";
  return normalized;
}

export function extractPriceChartingCardNumber(productName: string): string | null {
  const candidates = [
    productName.match(/#\s*([a-z0-9-]+)/i)?.[1] ?? null,
    productName.match(/\bno\.?\s*([a-z0-9-]+)/i)?.[1] ?? null,
    productName.match(/\b([a-z0-9-]+)\s*\/\s*\d+\b/i)?.[1] ?? null,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePriceChartingCardNumber(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function simplifiedSetText(value: string | null | undefined): string {
  return normalizePriceChartingMatchText(value)
    .replace(/\bpokemon\b/g, " ")
    .replace(/\bpokémon\b/g, " ")
    .replace(/\btcg\b/g, " ")
    .replace(/\bcards?\b/g, " ")
    .replace(/\bset\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 0));
}

function allTokensIncluded(needles: Set<string>, haystack: Set<string>): boolean {
  for (const token of needles) {
    if (!haystack.has(token)) return false;
  }
  return needles.size > 0;
}

function hasVariantReviewToken(productName: string): boolean {
  return VARIANT_REVIEW_PATTERNS.some((pattern) => pattern.test(productName))
    || hasUnresolvedBracketedVariant(productName);
}

function hasUnresolvedBracketedVariant(productName: string): boolean {
  const bracketedLabels = [...productName.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => normalizePriceChartingMatchText(match[1]));

  return bracketedLabels.some((label) =>
    label.length > 0 && !SAFE_BRACKETED_VARIANT_TOKENS.has(label)
  );
}

function inferFinish(productName: string): string | null {
  if (/\breverse\s*(holo|foil)\b/i.test(productName)) return "REVERSE_HOLO";
  if (/\bnon[-\s]?holo\b/i.test(productName)) return "NON_HOLO";
  if (/\bholo\b/i.test(productName)) return "HOLO";
  return null;
}

function inferEdition(productName: string): string | null {
  if (/\b(1st|first)\s*edition\b/i.test(productName)) return "FIRST_EDITION";
  if (/\bunlimited\b/i.test(productName)) return "UNLIMITED";
  return null;
}

function inferStamp(productName: string): string | null {
  if (/\bshadowless\b/i.test(productName)) return "SHADOWLESS";
  if (/\bstaff\b/i.test(productName)) return "STAFF";
  if (/\bprerelease\b/i.test(productName)) return "PRERELEASE";
  return null;
}

function isCardGenre(genre: string | null | undefined): boolean {
  return /\bpokemon cards?\b/.test(normalizePriceChartingMatchText(genre));
}

export function isPriceChartingEnglishSingleCardProduct(product: PriceChartingProductForMatch): boolean {
  if (!isCardGenre(product.genre)) return false;
  const consoleName = String(product.console_name ?? "");
  const combined = `${consoleName} ${product.product_name ?? ""}`;
  if (NON_ENGLISH_SET_PATTERNS.some((pattern) => pattern.test(combined))) return false;
  if (NON_TCG_PRODUCT_FAMILY_PATTERNS.some((pattern) => pattern.test(combined))) return false;
  return extractPriceChartingCardNumber(String(product.product_name ?? "")) !== null;
}

export function isPriceChartingCanonicalHeadlineProduct(product: PriceChartingProductForMatch): boolean {
  if (!isPriceChartingEnglishSingleCardProduct(product)) return false;

  const productName = String(product.product_name ?? "");
  if (/\[[^\]]+\]/.test(productName)) return false;
  if (hasVariantReviewToken(productName)) return false;
  if (inferFinish(productName) || inferEdition(productName) || inferStamp(productName)) return false;

  return true;
}

function findPrinting(params: {
  productName: string;
  canonicalSlug: string;
  printings: PriceChartingPrintingForMatch[];
}): {
  printingId: string | null;
  exactVariantRequired: boolean;
  variantMatched: boolean;
  reason: string | null;
} {
  const finish = inferFinish(params.productName);
  const edition = inferEdition(params.productName);
  const stamp = inferStamp(params.productName);
  const exactVariantRequired = hasVariantReviewToken(params.productName) || Boolean(finish || edition || stamp);
  const unresolvedBracketedVariant = hasUnresolvedBracketedVariant(params.productName);
  const rows = params.printings.filter((row) =>
    row.canonical_slug === params.canonicalSlug
    && String(row.language ?? "").trim().toUpperCase() === "EN"
  );

  if (rows.length === 0) {
    return { printingId: null, exactVariantRequired, variantMatched: false, reason: "NO_EN_PRINTINGS" };
  }

  const filtered = rows.filter((row) => {
    if (finish && row.finish !== finish) return false;
    if (edition && row.edition !== edition) return false;
    if (stamp && normalizePriceChartingMatchText(row.stamp) !== normalizePriceChartingMatchText(stamp)) return false;
    return true;
  });

  if ((finish || edition || stamp) && filtered.length === 1 && !unresolvedBracketedVariant) {
    return {
      printingId: filtered[0].id,
      exactVariantRequired,
      variantMatched: true,
      reason: null,
    };
  }

  if (exactVariantRequired) {
    return {
      printingId: null,
      exactVariantRequired,
      variantMatched: false,
      reason: "VARIANT_REQUIRES_PRINTING_REVIEW",
    };
  }

  if (rows.length === 1) {
    return {
      printingId: rows[0].id,
      exactVariantRequired,
      variantMatched: true,
      reason: null,
    };
  }

  return {
    printingId: null,
    exactVariantRequired,
    variantMatched: false,
    reason: "CANONICAL_MATCH_PRINTING_AMBIGUOUS",
  };
}

function scoreCandidate(params: {
  product: PriceChartingProductForMatch;
  card: PriceChartingCanonicalCardForMatch;
  productNumber: string;
}): Candidate | null {
  if (String(params.card.language ?? "").trim().toUpperCase() !== "EN") return null;
  const cardNumber = normalizePriceChartingCardNumber(params.card.card_number);
  if (!cardNumber || cardNumber !== params.productNumber) return null;

  const productText = normalizePriceChartingMatchText(`${params.product.product_name} ${params.product.console_name ?? ""}`);
  const productTokens = tokenSet(productText);
  const cardNameTokens = tokenSet(normalizePriceChartingMatchText(params.card.canonical_name));
  if (!allTokensIncluded(cardNameTokens, productTokens)) return null;

  const setText = simplifiedSetText(params.card.set_name);
  const productSetText = simplifiedSetText(`${params.product.console_name ?? ""} ${params.product.product_name}`);
  const setTokens = tokenSet(setText);
  const productSetTokens = tokenSet(productSetText);
  const setMatch = setText.length > 0 && (
    productSetText.includes(setText)
    || setText.includes(productSetText)
    || allTokensIncluded(setTokens, productSetTokens)
  );
  if (!setMatch) return null;

  return {
    card: params.card,
    nameScore: cardNameTokens.size,
    setScore: setTokens.size,
  };
}

export function buildPriceChartingMatchDecision(params: {
  product: PriceChartingProductForMatch;
  canonicalCards: PriceChartingCanonicalCardForMatch[];
  printings: PriceChartingPrintingForMatch[];
}): PriceChartingMatchDecision {
  const productId = String(params.product.product_id ?? "").trim();
  const productName = String(params.product.product_name ?? "").trim();
  const productNumber = extractPriceChartingCardNumber(productName);
  const identityBase = {
    productName,
    consoleName: params.product.console_name ?? null,
    extractedCardNumber: productNumber,
  };

  if (!productNumber) {
    return {
      productId,
      canonicalSlug: null,
      printingId: null,
      matchStatus: "UNMATCHED",
      matchType: null,
      matchConfidence: null,
      matchReason: "MISSING_CARD_NUMBER",
      identity: identityBase,
    };
  }

  const candidates = params.canonicalCards
    .map((card) => scoreCandidate({ product: params.product, card, productNumber }))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((left, right) =>
      right.setScore - left.setScore
      || right.nameScore - left.nameScore
      || left.card.slug.localeCompare(right.card.slug)
    );

  if (candidates.length === 0) {
    return {
      productId,
      canonicalSlug: null,
      printingId: null,
      matchStatus: "UNMATCHED",
      matchType: null,
      matchConfidence: null,
      matchReason: "NO_CANONICAL_IDENTITY_MATCH",
      identity: identityBase,
    };
  }

  const top = candidates[0];
  const ties = candidates.filter((candidate) =>
    candidate.setScore === top.setScore
    && candidate.nameScore === top.nameScore
  );
  if (ties.length > 1) {
    return {
      productId,
      canonicalSlug: top.card.slug,
      printingId: null,
      matchStatus: "NEEDS_REVIEW",
      matchType: "AUTO_CANONICAL_AMBIGUOUS",
      matchConfidence: 70,
      matchReason: "MULTIPLE_CANONICAL_CANDIDATES",
      identity: {
        ...identityBase,
        candidateSlugs: ties.map((candidate) => candidate.card.slug).slice(0, 10),
      },
    };
  }

  const printing = findPrinting({
    productName,
    canonicalSlug: top.card.slug,
    printings: params.printings,
  });

  if (printing.exactVariantRequired && !printing.variantMatched) {
    return {
      productId,
      canonicalSlug: top.card.slug,
      printingId: null,
      matchStatus: "NEEDS_REVIEW",
      matchType: "AUTO_CANONICAL_VARIANT_REVIEW",
      matchConfidence: 82,
      matchReason: printing.reason,
      identity: {
        ...identityBase,
        canonicalName: top.card.canonical_name,
        setName: top.card.set_name,
        inferredFinish: inferFinish(productName),
        inferredEdition: inferEdition(productName),
        inferredStamp: inferStamp(productName),
      },
    };
  }

  return {
    productId,
    canonicalSlug: top.card.slug,
    printingId: printing.printingId,
    matchStatus: "MATCHED",
    matchType: printing.printingId ? "AUTO_EXACT_PRINTING_OR_CANONICAL" : "AUTO_EXACT_CANONICAL",
    matchConfidence: printing.printingId ? 98 : 92,
    matchReason: null,
    identity: {
      ...identityBase,
      canonicalName: top.card.canonical_name,
      setName: top.card.set_name,
      printingResolution: printing.reason,
    },
  };
}
