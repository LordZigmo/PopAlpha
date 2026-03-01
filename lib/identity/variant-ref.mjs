const GRADED_PROVIDERS = new Set(["PSA", "CGC", "BGS", "TAG"]);
const INTERNAL_GRADE_TO_BUCKET = {
  RAW: "RAW",
  LE_7: "7_OR_LESS",
  G8: "8",
  G9: "9",
  G10: "10",
  "7_OR_LESS": "7_OR_LESS",
  "8": "8",
  "9": "9",
  "10": "10",
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

  const gradedMatch = rawValue.match(/^(.+)::(PSA|CGC|BGS|TAG)::(7_OR_LESS|8|9|10)$/);
  if (!gradedMatch) return null;

  return {
    printingId: gradedMatch[1],
    mode: "GRADED",
    provider: gradedMatch[2],
    gradeBucket: gradedMatch[3],
  };
}
