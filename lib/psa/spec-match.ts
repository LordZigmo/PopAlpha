/**
 * PSA SpecID → catalog matching: pure decision logic.
 *
 * A PSA "spec" is one (set, card number, subject, variety) combination —
 * finer than a canonical card (1st Edition Holo and Unlimited are
 * different specs of the same card), which is why a match lands on
 * canonical_slug + an optional printing_id, mirroring provider_card_map.
 *
 * This module is deliberately DB-free so the matching rules are unit
 * testable (tests/psa-spec-match.test.mjs). The DB-driven runner lives in
 * lib/backfill/psa-spec-match.ts.
 *
 * Inputs come from PSACert payloads (Year/Brand/Category/CardNumber/
 * Subject/Variety) — NOT from psa_spec_targets.description, which is a
 * lossy concatenation of these fields.
 *
 * Matching ladder (mirrors lib/backfill/pokemontcg-normalized-match.ts):
 *   1. Resolve the PSA Brand string to a canonical set_code — curated
 *      psa_set_map row first, then deterministic derivation (embedded set
 *      code like "SV4a-", normalized set-name equality). No resolution ⇒
 *      UNMATCHED MISSING_PSA_SET_MAP (the curation queue).
 *   2. Within the set: card_number-driven candidate selection,
 *      subject-verified against canonical_name. A number hit whose name
 *      disagrees is SUSPICIOUS (SUBJECT_MISMATCH), never a silent match —
 *      a wrong slug shows a user the wrong card's population, which is
 *      worse than no data.
 *   3. Variety resolves finish/edition/stamp to pick a printing when it
 *      can; failure to pin the printing does NOT fail the slug match.
 *
 * Everything below the auto-confidence threshold is queued (UNMATCHED +
 * reason + proposal metadata), never silently guessed.
 */

export type PsaSpecFields = {
  specId: number;
  year: string | null;
  brand: string | null;
  category: string | null;
  cardNumber: string | null;
  subject: string | null;
  variety: string | null;
};

export type CanonicalSetIndexRow = {
  set_code: string;
  set_name: string;
  language: string;
  year_min: number | null;
  year_max: number | null;
};

export type PsaSetMapRow = {
  psa_brand_key: string;
  canonical_set_code: string;
  canonical_set_name: string | null;
  language: string;
  confidence: number;
  source: "SEED" | "DERIVED" | "MANUAL";
};

export type PsaPrintingRow = {
  id: string;
  canonical_slug: string;
  set_code: string | null;
  card_number: string;
  language: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

export type PsaSetResolution = {
  setCode: string;
  setName: string | null;
  language: string;
  method: "CURATED" | "DERIVED_CODE" | "DERIVED_NAME" | "DERIVED_CODE_NAME";
  confidence: number;
};

export type PsaSpecDecision =
  | {
      status: "MATCHED";
      canonicalSlug: string;
      printingId: string | null;
      matchType: string;
      confidence: number;
      metadata: Record<string, unknown>;
    }
  | {
      status: "UNMATCHED";
      reason: string;
      metadata: Record<string, unknown>;
    };

/** Categories that represent gradable single cards. Everything else
 * (PACKS, COINS, …) is explicitly queued as non-card. */
const CARD_CATEGORIES = new Set(["TCG CARDS"]);

/** Brand tokens that never carry set identity. "EN" shows up in modern
 * brands like "SVP EN-SV BLACK STAR PROMO". */
const BRAND_NOISE_TOKENS = new Set(["POKEMON", "EN", "TCG"]);

/** Leading series qualifiers PSA prepends that our set names omit
 * (e.g. "POKEMON SWORD & SHIELD EVOLVING SKIES" vs "Evolving Skies").
 * Tried as a strip-prefix variant — never required. Multi-token
 * prefixes are matched against the head of the phrase token list. */
const SERIES_PREFIXES: string[][] = [
  ["SWORD", "AND", "SHIELD"],
  ["SUN", "AND", "MOON"],
  ["SCARLET", "AND", "VIOLET"],
  ["DIAMOND", "AND", "PEARL"],
  ["HEARTGOLD", "AND", "SOULSILVER"],
  ["BLACK", "AND", "WHITE"],
  ["XY"],
  ["EX"],
  ["SM"],
  ["SWSH"],
  ["SV"],
];

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical form for psa_set_map.psa_brand_key: uppercase, ASCII
 * quotes, single spaces. Punctuation is preserved because it is
 * meaningful in PSA brands ("INT'L", "SV4a-SHINY TREASURE ex"). */
export function normalizePsaBrandKey(brand: string | null | undefined): string {
  return stripDiacritics(String(brand ?? ""))
    .toUpperCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose token form used for name comparison: alphanumeric tokens only,
 * "&"→AND, PROMOS→PROMO so plural drift can't break equality. */
export function tokenizeForNameMatch(value: string | null | undefined): string[] {
  const cleaned = stripDiacritics(String(value ?? ""))
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(" ").map((token) => (token === "PROMOS" ? "PROMO" : token));
}

export type ParsedPsaBrand = {
  key: string;
  language: "EN" | "JP";
  /** Name-comparison tokens with POKEMON/JAPANESE/noise removed. */
  phraseTokens: string[];
  /** Tokens that look like embedded set codes ("SV4A", "SVP", "SWSH"). */
  codeCandidates: string[];
};

export function parsePsaBrand(brand: string | null | undefined): ParsedPsaBrand {
  const key = normalizePsaBrandKey(brand);
  const rawTokens = tokenizeForNameMatch(key);
  const language: "EN" | "JP" = rawTokens.includes("JAPANESE") ? "JP" : "EN";

  const phraseTokens = rawTokens.filter(
    (token) => token !== "JAPANESE" && !BRAND_NOISE_TOKENS.has(token),
  );

  // Embedded set codes: PSA's modern brands lead with the abbreviation —
  // "SV4a-SHINY TREASURE ex", "SVP EN-SV BLACK STAR PROMO". A token
  // qualifies when it mixes letters+digits anywhere in the phrase, or is
  // a short pure-letter token in lead position (SVP, SWSH). Candidates
  // are only ever USED when they hit a real set_code in the index, so a
  // false candidate costs nothing.
  const codeCandidates: string[] = [];
  for (const [index, token] of phraseTokens.entries()) {
    const mixed = /^[A-Z]{1,6}\d{1,4}[A-Z]{0,3}$/.test(token);
    const leadAbbrev = index === 0 && /^[A-Z]{2,5}$/.test(token) && token.length <= 5;
    if ((mixed || leadAbbrev) && !codeCandidates.includes(token)) {
      codeCandidates.push(token);
    }
  }

  return { key, language, phraseTokens, codeCandidates };
}

function phraseVariants(phraseTokens: string[]): string[][] {
  const variants: string[][] = [phraseTokens];
  for (const prefix of SERIES_PREFIXES) {
    if (phraseTokens.length > prefix.length
      && prefix.every((token, index) => phraseTokens[index] === token)) {
      variants.push(phraseTokens.slice(prefix.length));
    }
  }
  // Code tokens already tried via codeCandidates can shadow the name
  // ("SV4A SHINY TREASURE EX" → "SHINY TREASURE EX").
  if (phraseTokens.length > 1 && /\d/.test(phraseTokens[0] ?? "")) {
    variants.push(phraseTokens.slice(1));
  }
  return variants.filter((tokens) => tokens.length > 0);
}

/**
 * Resolve a parsed PSA brand to a canonical set.
 *
 * Curated psa_set_map rows always win. Derivation only accepts UNIQUE
 * hits — a phrase or code matching two sets resolves nothing (the spec
 * queues as MISSING_PSA_SET_MAP for curation).
 */
export function resolvePsaSet(params: {
  parsed: ParsedPsaBrand;
  curatedByKey: Map<string, PsaSetMapRow>;
  setIndex: CanonicalSetIndexRow[];
}): PsaSetResolution | null {
  const { parsed, curatedByKey, setIndex } = params;

  const curated = curatedByKey.get(parsed.key);
  if (curated) {
    return {
      setCode: curated.canonical_set_code,
      setName: curated.canonical_set_name,
      language: curated.language,
      method: "CURATED",
      confidence: Math.min(1, Math.max(0, curated.confidence)),
    };
  }

  const languageRows = setIndex.filter((row) => row.language === parsed.language);

  // Path A: embedded set code. JP brands try the _ja-suffixed code first
  // (PSA says "SV4a", our JP codes are "sv4a_ja").
  const codeHits = new Map<string, CanonicalSetIndexRow>();
  for (const candidate of parsed.codeCandidates) {
    const lowered = candidate.toLowerCase();
    const probes = parsed.language === "JP" ? [`${lowered}_ja`, lowered] : [lowered];
    for (const probe of probes) {
      const hit = languageRows.find((row) => row.set_code.toLowerCase() === probe);
      if (hit) {
        codeHits.set(hit.set_code, hit);
        break;
      }
    }
  }

  // Path B: normalized set-name equality across phrase variants.
  const nameHits = new Map<string, CanonicalSetIndexRow>();
  const variants = phraseVariants(parsed.phraseTokens).map((tokens) => tokens.join(" "));
  for (const row of languageRows) {
    const rowName = tokenizeForNameMatch(row.set_name).join(" ");
    if (!rowName) continue;
    if (variants.includes(rowName)) {
      nameHits.set(row.set_code, row);
    }
  }

  const codeHit = codeHits.size === 1 ? [...codeHits.values()][0] : null;
  const nameHit = nameHits.size === 1 ? [...nameHits.values()][0] : null;

  if (codeHit && nameHit) {
    // Both paths agreeing is the strongest derived signal; disagreeing
    // paths mean the brand is ambiguous — refuse to resolve.
    if (codeHit.set_code !== nameHit.set_code) return null;
    return {
      setCode: codeHit.set_code,
      setName: codeHit.set_name,
      language: codeHit.language,
      method: "DERIVED_CODE_NAME",
      confidence: 0.95,
    };
  }
  if (nameHit && nameHits.size === 1) {
    return {
      setCode: nameHit.set_code,
      setName: nameHit.set_name,
      language: nameHit.language,
      method: "DERIVED_NAME",
      confidence: 0.92,
    };
  }
  if (codeHit && codeHits.size === 1) {
    return {
      setCode: codeHit.set_code,
      setName: codeHit.set_name,
      language: codeHit.language,
      method: "DERIVED_CODE",
      confidence: 0.9,
    };
  }
  return null;
}

export type ParsedPsaVariety = {
  cleanedSubject: string;
  edition: "FIRST_EDITION" | "UNLIMITED" | null;
  finish: "HOLO" | "REVERSE_HOLO" | "NON_HOLO" | null;
  stamp: string | null;
  /** Recognized descriptors that carry no printing signal (rarity names,
   * collab labels) — present so they don't read as parse failures. */
  descriptorTokens: string[];
  unparsedTokens: string[];
};

/** Descriptor phrases PSA puts in Variety that describe rarity/art, not
 * a finish/edition/stamp axis we can map onto card_printings. */
const VARIETY_DESCRIPTORS = [
  "SPECIAL ART RARE",
  "ART RARE",
  "SECRET RARE",
  "HYPER RARE",
  "ULTRA RARE",
  "FULL ART",
  "ALT ART",
  "ALTERNATE ART",
  "RAINBOW RARE",
  "GOLD",
  "STAINED GLASS",
  "POKEMON X VAN GOGH",
];

/**
 * Interpret PSA's Variety (plus Subject suffixes like "PIKACHU - HOLO")
 * into printing axes. Unknown tokens are reported, never guessed.
 */
export function parsePsaVariety(
  variety: string | null | undefined,
  subject: string | null | undefined,
): ParsedPsaVariety {
  let cleanedSubject = String(subject ?? "").trim();
  let finish: ParsedPsaVariety["finish"] = null;
  let edition: ParsedPsaVariety["edition"] = null;
  let stamp: string | null = null;
  const descriptorTokens: string[] = [];
  const unparsedTokens: string[] = [];

  // PSA sometimes carries the finish on the subject ("PIKACHU - HOLO").
  const subjectFinish = cleanedSubject.match(/\s*[-–]\s*(HOLO|REVERSE HOLO|REVERSE FOIL)$/i);
  if (subjectFinish) {
    cleanedSubject = cleanedSubject.slice(0, subjectFinish.index).trim();
    finish = /REVERSE/i.test(subjectFinish[1] ?? "") ? "REVERSE_HOLO" : "HOLO";
  }

  let working = ` ${normalizePsaBrandKey(variety)} `;
  const consume = (pattern: RegExp): boolean => {
    if (!pattern.test(working)) return false;
    working = working.replace(pattern, " ");
    return true;
  };

  for (const descriptor of VARIETY_DESCRIPTORS) {
    const pattern = new RegExp(`(?<=[ \\-])${descriptor.replace(/ /g, "[ \\-]")}(?=[ \\-])`);
    if (consume(pattern)) descriptorTokens.push(descriptor);
  }

  if (consume(/(?<=[ \-])1ST\.? ?(EDITION|ED\.?)(?=[ \-])/)) edition = "FIRST_EDITION";
  if (consume(/(?<=[ \-])UNLIMITED(?=[ \-])/)) edition = edition ?? "UNLIMITED";
  if (consume(/(?<=[ \-])REVERSE ?(HOLO|FOIL)(?=[ \-])/)) finish = "REVERSE_HOLO";
  if (consume(/(?<=[ \-])NON[ \-]?HOLO(?=[ \-])/)) finish = finish ?? "NON_HOLO";
  if (consume(/(?<=[ \-])HOLO(?=[ \-])/)) finish = finish ?? "HOLO";
  if (consume(/(?<=[ \-])SHADOWLESS(?=[ \-])/)) stamp = "SHADOWLESS";
  if (consume(/(?<=[ \-])MASTER BALL(?=[ \-])/)) stamp = "MASTER_BALL_PATTERN";
  if (consume(/(?<=[ \-])POKE ?BALL(?=[ \-])/)) stamp = "POKE_BALL_PATTERN";
  if (consume(/(?<=[ \-])COSMOS HOLO(?=[ \-])/)) stamp = "COSMOS_HOLO";

  for (const leftover of working.split(/[ \-]+/)) {
    const token = leftover.trim();
    if (token) unparsedTokens.push(token);
  }

  return { cleanedSubject, edition, finish, stamp, descriptorTokens, unparsedTokens };
}

/** "085" / "85" / "044/030" → comparable forms. */
export function normalizePsaCardNumber(value: string | null | undefined): {
  raw: string;
  zeroStripped: string;
} {
  const trimmed = String(value ?? "").trim().toUpperCase();
  const withoutTotal = trimmed.includes("/") ? (trimmed.split("/")[0] ?? "").trim() : trimmed;
  const zeroStripped = withoutTotal.replace(/^0+(?=[0-9A-Z])/, "");
  return { raw: withoutTotal, zeroStripped: zeroStripped || withoutTotal };
}

const SUBJECT_STOPWORDS = new Set(["WITH", "THE", "AND", "ON", "IN", "OF", "A"]);

/**
 * Subject vs canonical_name agreement score.
 *   1.0  — token-identical ("MEW EX" vs "Mew ex")
 *   0.93 — token subset either way, ignoring stopwords
 *          ("PIKACHU GREY FELT HAT" ⊂ "Pikachu with Grey Felt Hat")
 *   0    — disagreement
 */
export function subjectAgreementScore(
  psaSubject: string | null | undefined,
  canonicalName: string | null | undefined,
): number {
  const psaTokens = tokenizeForNameMatch(psaSubject).filter((t) => !SUBJECT_STOPWORDS.has(t));
  const nameTokens = tokenizeForNameMatch(canonicalName).filter((t) => !SUBJECT_STOPWORDS.has(t));
  if (psaTokens.length === 0 || nameTokens.length === 0) return 0;
  if (psaTokens.join(" ") === nameTokens.join(" ")) return 1;
  const psaSet = new Set(psaTokens);
  const nameSet = new Set(nameTokens);
  const psaInName = psaTokens.every((token) => nameSet.has(token));
  const nameInPsa = nameTokens.every((token) => psaSet.has(token));
  if (psaInName || nameInPsa) return 0.93;
  return 0;
}

function numberAgreement(
  psa: { raw: string; zeroStripped: string },
  printingNumber: string,
): { matches: boolean; exact: boolean } {
  const printing = normalizePsaCardNumber(printingNumber);
  if (psa.raw && psa.raw === printing.raw) return { matches: true, exact: true };
  if (psa.zeroStripped && psa.zeroStripped === printing.zeroStripped) {
    return { matches: true, exact: false };
  }
  return { matches: false, exact: false };
}

/**
 * The core decision: spec fields + resolved set + that set's printings
 * (with canonical names) → matched slug/printing or an explicit queue
 * entry. Confidence composes set confidence × subject agreement ×
 * number exactness; the runner gates persistence at the auto threshold.
 */
export function decideSpecMatch(params: {
  fields: PsaSpecFields;
  setResolution: PsaSetResolution | null;
  printings: PsaPrintingRow[];
  canonicalNamesBySlug: Map<string, string>;
}): PsaSpecDecision {
  const { fields, setResolution, printings, canonicalNamesBySlug } = params;
  const parsedBrand = parsePsaBrand(fields.brand);
  const baseMetadata: Record<string, unknown> = {
    specId: fields.specId,
    psaBrandKey: parsedBrand.key,
    psaYear: fields.year,
    psaCategory: fields.category,
    psaCardNumber: fields.cardNumber,
    psaSubject: fields.subject,
    psaVariety: fields.variety,
  };

  const category = String(fields.category ?? "").trim().toUpperCase();
  if (category && !CARD_CATEGORIES.has(category)) {
    return {
      status: "UNMATCHED",
      reason: "NON_CARD_CATEGORY",
      metadata: { ...baseMetadata, category },
    };
  }

  if (!setResolution) {
    return {
      status: "UNMATCHED",
      reason: "MISSING_PSA_SET_MAP",
      metadata: {
        ...baseMetadata,
        language: parsedBrand.language,
        phrase: parsedBrand.phraseTokens.join(" "),
        codeCandidates: parsedBrand.codeCandidates,
      },
    };
  }

  const setMetadata = {
    ...baseMetadata,
    setCode: setResolution.setCode,
    setMethod: setResolution.method,
    setConfidence: setResolution.confidence,
  };

  const variety = parsePsaVariety(fields.variety, fields.subject);
  const setPrintings = printings.filter(
    (row) => row.set_code === setResolution.setCode && row.language === setResolution.language,
  );
  if (setPrintings.length === 0) {
    return {
      status: "UNMATCHED",
      reason: "NO_PRINTINGS_FOR_SET",
      metadata: setMetadata,
    };
  }

  const psaNumber = normalizePsaCardNumber(fields.cardNumber);

  // ── No card number: name-driven proposal only, never an auto match ──
  if (!psaNumber.raw) {
    const slugScores = new Map<string, number>();
    for (const row of setPrintings) {
      if (slugScores.has(row.canonical_slug)) continue;
      const score = subjectAgreementScore(
        variety.cleanedSubject,
        canonicalNamesBySlug.get(row.canonical_slug) ?? null,
      );
      if (score > 0) slugScores.set(row.canonical_slug, score);
    }
    if (slugScores.size === 1) {
      const [slug, score] = [...slugScores.entries()][0]!;
      return {
        status: "UNMATCHED",
        reason: "NO_CARD_NUMBER_PROPOSED",
        metadata: {
          ...setMetadata,
          proposedSlug: slug,
          proposedConfidence: Number((setResolution.confidence * score * 0.85).toFixed(3)),
        },
      };
    }
    return {
      status: "UNMATCHED",
      reason: slugScores.size === 0 ? "NO_CARD_NUMBER" : "AMBIGUOUS_NO_CARD_NUMBER",
      metadata: { ...setMetadata, nameCandidates: [...slugScores.keys()].slice(0, 5) },
    };
  }

  // ── Number-driven candidates, subject-verified ──────────────────────
  const numberRows: Array<{ row: PsaPrintingRow; exact: boolean }> = [];
  for (const row of setPrintings) {
    const agreement = numberAgreement(psaNumber, row.card_number);
    if (agreement.matches) numberRows.push({ row, exact: agreement.exact });
  }
  if (numberRows.length === 0) {
    return {
      status: "UNMATCHED",
      reason: "NO_PRINTINGS_FOR_SET_NUMBER",
      metadata: { ...setMetadata, setPrintings: setPrintings.length },
    };
  }

  const slugs = [...new Set(numberRows.map((entry) => entry.row.canonical_slug))];
  const scoredSlugs = slugs
    .map((slug) => ({
      slug,
      score: subjectAgreementScore(variety.cleanedSubject, canonicalNamesBySlug.get(slug) ?? null),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredSlugs.length === 0) {
    return {
      status: "UNMATCHED",
      reason: "SUBJECT_MISMATCH",
      metadata: {
        ...setMetadata,
        numberSlugs: slugs.slice(0, 5),
        candidateNames: slugs
          .map((slug) => canonicalNamesBySlug.get(slug))
          .filter(Boolean)
          .slice(0, 5),
      },
    };
  }
  if (scoredSlugs.length > 1 && scoredSlugs[0]!.score === scoredSlugs[1]!.score) {
    return {
      status: "UNMATCHED",
      reason: "AMBIGUOUS_NUMBER_MULTI_SLUG",
      metadata: { ...setMetadata, numberSlugs: scoredSlugs.map((entry) => entry.slug).slice(0, 5) },
    };
  }

  const winner = scoredSlugs[0]!;
  const slugRows = numberRows.filter((entry) => entry.row.canonical_slug === winner.slug);
  const numberExact = slugRows.some((entry) => entry.exact);

  // ── Printing selection from Variety (best-effort, never fatal) ──────
  let printingId: string | null = null;
  let printingResolution = "PRINTING_UNRESOLVED";
  const wantsAxes = variety.finish !== null || variety.edition !== null || variety.stamp !== null;
  if (slugRows.length === 1 && !wantsAxes) {
    printingId = slugRows[0]!.row.id;
    printingResolution = "PRINTING_ONLY_OPTION";
  } else if (wantsAxes) {
    const strict = slugRows.filter(({ row }) => {
      const finishOk = variety.finish === null || row.finish === variety.finish;
      const editionOk = variety.edition === null
        ? row.edition !== "FIRST_EDITION"
        : row.edition === variety.edition;
      const stampOk = variety.stamp === null
        ? !row.stamp
        : row.stamp === variety.stamp;
      return finishOk && editionOk && stampOk;
    });
    if (strict.length === 1) {
      printingId = strict[0]!.row.id;
      printingResolution = "PRINTING_VARIETY_EXACT";
    } else {
      printingResolution = strict.length === 0 ? "PRINTING_VARIETY_NO_FIT" : "PRINTING_VARIETY_AMBIGUOUS";
    }
  } else if (slugRows.length === 1) {
    printingId = slugRows[0]!.row.id;
    printingResolution = "PRINTING_ONLY_OPTION";
  }

  const confidence = Number(
    (setResolution.confidence * winner.score * (numberExact ? 1 : 0.99)).toFixed(3),
  );
  const matchType = winner.score === 1
    ? "SET_NUMBER_SUBJECT_EXACT"
    : "SET_NUMBER_SUBJECT_PARTIAL";

  return {
    status: "MATCHED",
    canonicalSlug: winner.slug,
    printingId,
    matchType,
    confidence,
    metadata: {
      ...setMetadata,
      subjectScore: winner.score,
      numberExact,
      printingResolution,
      varietyEdition: variety.edition,
      varietyFinish: variety.finish,
      varietyStamp: variety.stamp,
      varietyUnparsed: variety.unparsedTokens,
    },
  };
}
