const GRADED_PROVIDERS = new Set(["PSA", "CGC", "BGS", "TAG"]);
const INTERNAL_GRADE_TO_BUCKET = {
  RAW: "RAW",
  LE_7: "7_OR_LESS",
  G8: "8",
  G9: "9",
  G9_5: "9_5",
  G10: "10",
  G10_PERFECT: "10_PERFECT",
  "7_OR_LESS": "7_OR_LESS",
  "8": "8",
  "9": "9",
  "9_5": "9_5",
  "10": "10",
  "10_PERFECT": "10_PERFECT",
};

function normalizePrintingId(printingId) {
  const normalized = String(printingId ?? "").trim();
  if (!normalized) {
    throw new Error("printingId is required to build a canonical variant_ref");
  }
  if (normalized.includes("::")) {
    throw new Error("printingId cannot contain '::'");
  }
  return normalized;
}

function normalizeProvider(provider) {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (!GRADED_PROVIDERS.has(normalized)) {
    throw new Error(`Unsupported graded provider: ${provider}`);
  }
  return normalized;
}

function normalizeGradeBucket(grade) {
  const key = String(grade ?? "RAW").trim().toUpperCase();
  const bucket = INTERNAL_GRADE_TO_BUCKET[key];
  if (!bucket) {
    throw new Error(`Unsupported grade bucket: ${grade}`);
  }
  return bucket;
}

export function buildRawVariantRef(printingId) {
  return `${normalizePrintingId(printingId)}::RAW`;
}

export function buildGradedVariantRef(printingId, provider, gradeBucket) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedGradeBucket = normalizeGradeBucket(gradeBucket);
  if (normalizedGradeBucket === "RAW") {
    return buildRawVariantRef(printingId);
  }
  return `${normalizePrintingId(printingId)}::${normalizedProvider}::${normalizedGradeBucket}`;
}

export function buildVariantRef({ printingId, provider = null, grade = "RAW" }) {
  const normalizedGradeBucket = normalizeGradeBucket(grade);
  if (normalizedGradeBucket === "RAW" || !provider) {
    return buildRawVariantRef(printingId);
  }
  return buildGradedVariantRef(printingId, provider, normalizedGradeBucket);
}

/**
 * Matched raw singles keep the provider variant id in the history key so
 * finish-specific market series do not collapse into the same RAW bucket.
 * These are history/storage keys, not the canonical display variant_ref
 * contract returned by buildRawVariantRef/buildVariantRef.
 *
 * @param {{
 *   printingId?: string | null,
 *   canonicalSlug?: string | null,
 *   provider: string,
 *   providerVariantId: string,
 * }} input
 */
export function buildProviderHistoryVariantRef({
  printingId = null,
  canonicalSlug = null,
  provider,
  providerVariantId,
}) {
  const normalizedProviderVariantId = String(providerVariantId ?? "").trim();
  if (!normalizedProviderVariantId) {
    throw new Error("providerVariantId is required to build a provider history variant_ref");
  }

  const normalizedPrintingId = String(printingId ?? "").trim();
  if (normalizedPrintingId) {
    return `${normalizePrintingId(normalizedPrintingId)}::${normalizedProviderVariantId}::RAW`;
  }

  const normalizedCanonicalSlug = String(canonicalSlug ?? "").trim();
  if (normalizedCanonicalSlug) {
    return `${normalizedCanonicalSlug}::${normalizedProviderVariantId}::RAW`;
  }

  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if (!normalizedProvider) {
    throw new Error("provider is required when printingId and canonicalSlug are absent");
  }

  return `${normalizedProvider}:${normalizedProviderVariantId}::RAW`;
}

/**
 * Parses only canonical display variant_ref values:
 *   - <printing_id>::RAW
 *   - <printing_id>::<provider>::<grade_bucket>
 *
 * Provider-history RAW keys created by buildProviderHistoryVariantRef keep
 * an extra provider-variant segment and are intentionally not normalized here.
 */
export function parseVariantRef(variantRef) {
  const rawValue = String(variantRef ?? "").trim();
  if (!rawValue) return null;

  const rawMatch = rawValue.match(/^(.+)::RAW$/);
  if (rawMatch) {
    return {
      printingId: rawMatch[1],
      mode: "RAW",
      provider: null,
      gradeBucket: "RAW",
    };
  }

  const gradedMatch = rawValue.match(/^(.+)::(PSA|CGC|BGS|TAG)::(7_OR_LESS|8|9|9_5|10|10_PERFECT)$/);
  if (!gradedMatch) return null;

  return {
    printingId: gradedMatch[1],
    mode: "GRADED",
    provider: gradedMatch[2],
    gradeBucket: gradedMatch[3],
  };
}
