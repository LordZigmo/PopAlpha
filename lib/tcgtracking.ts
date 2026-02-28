import { unstable_cache } from "next/cache";

const TCGTRACKING_BASE_URL = "https://tcgtracking.com/tcgapi/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const FIVE_MINUTES = 300;
const ONE_HOUR = 3_600;
const ONE_DAY = 86_400;
const PREFERRED_SUBTYPES = [
  "normal",
  "nonfoil",
  "non-foil",
  "holo",
  "holofoil",
  "foil",
  "reverseholo",
  "reverseholofoil",
  "reverse-holo",
  "1stedition",
];

type JsonObject = Record<string, unknown>;

type TcgTrackingSetSummary = {
  id: string | number;
  name?: string | null;
  abbr?: string | null;
  set_abbr?: string | null;
  code?: string | null;
  year?: number | null;
  release_date?: string | null;
  releaseDate?: string | null;
};

type TcgTrackingSetSearchPayload = {
  sets?: TcgTrackingSetSummary[];
};

type TcgTrackingProduct = {
  id: string | number;
  name?: string | null;
  number?: string | null;
  set_name?: string | null;
};

type TcgTrackingProductsPayload = {
  products?: TcgTrackingProduct[];
  set_name?: string | null;
};

type TcgTrackingPriceFields = {
  low?: number | null;
  market?: number | null;
  mid?: number | null;
  high?: number | null;
};

type TcgTrackingPriceNode = {
  tcg?: Record<string, TcgTrackingPriceFields>;
  updated?: string | null;
};

type TcgTrackingPricingPayload = {
  prices?: Record<string, TcgTrackingPriceNode>;
  updated?: string | null;
};

export type TcgPricingItem = {
  productId: string;
  name: string | null;
  number: string | null;
  setName: string | null;
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  currency: string;
  updatedAt: string | null;
  raw: {
    subtype: string | null;
    pricing: unknown;
    product: unknown;
  };
};

export type TcgSetPricingPayload = {
  cat: number;
  setId: string;
  setName: string | null;
  updatedAt: string | null;
  items: TcgPricingItem[];
};

export type TcgTrackingSetMatch = {
  id: string;
  name: string | null;
  abbr: string | null;
};

export type TcgTrackingSetCandidate = {
  id: string;
  name: string | null;
  code: string | null;
  year: number | null;
  normalizedName: string;
  score: number;
  similarity: number;
  codeMatched: boolean;
};

export type TcgTrackingSetResolution = {
  queryUsed: string | null;
  normalizedQuery: string | null;
  candidates: TcgTrackingSetCandidate[];
  chosen: TcgTrackingSetCandidate | null;
};

export type TcgProductMatchCandidate = {
  productId: string;
  name: string | null;
  number: string | null;
  rarity: string | null;
  marketPrice: number | null;
  score: number;
  nameSimilarity: number;
  numberMatched: boolean;
  hasNumber: boolean;
};

export type TcgProductResolution = {
  productsInSet: number;
  topCandidates: TcgProductMatchCandidate[];
  chosen: TcgProductMatchCandidate | null;
  chosenReason: string | null;
  warning: string | null;
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toOptionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLookup(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeSetCode(value: string | null | undefined): string {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function normalizePunctuation(value: string | null | undefined): string {
  return normalizeWhitespace((value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " "));
}

export function normalizeSetName(value: string | null | undefined): string {
  let normalized = normalizePunctuation(value)
    .replace(/\bscarlet\s+and\s+violet\b/g, "sv")
    .replace(/\bscarlet\s+violet\b/g, "sv")
    .replace(/\bsword\s+and\s+shield\b/g, "swsh")
    .replace(/\bsword\s+shield\b/g, "swsh");

  normalized = normalized.replace(/\bsv\s+(\d+)\b/g, "sv$1").replace(/\bswsh\s+(\d+)\b/g, "swsh$1");
  return normalizeWhitespace(normalized);
}

function parseLeadingCardNumber(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const slashMatch = trimmed.match(/^#?\s*(\d+)\s*\/\s*\d+/i);
  if (slashMatch) return slashMatch[1];
  const digitsMatch = trimmed.match(/^#?\s*(\d+)/);
  if (digitsMatch) return digitsMatch[1];
  return normalizeLookup(trimmed);
}

export function normalizeCardNumber(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  return lower.replace(/^#\s*/, "");
}

function parseSetYear(set: TcgTrackingSetSummary): number | null {
  if (typeof set.year === "number" && Number.isFinite(set.year)) {
    return Math.round(set.year);
  }

  const fromDate = toNullableString(set.release_date ?? set.releaseDate);
  if (!fromDate) return null;
  const match = fromDate.match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getSetCode(set: TcgTrackingSetSummary): string | null {
  return toNullableString(set.code ?? set.abbr ?? set.set_abbr);
}

function buildSetQueryCandidates(setCode: string | null | undefined, setName: string | null | undefined): string[] {
  const values = [setCode, setName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const normalizedVariants = [normalizeSetName(setName), normalizeSetCode(setCode)].filter((value) => value.length > 0);
  return Array.from(new Set([...values, ...normalizedVariants]));
}

function normalizeSubtype(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const asSeconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(asSeconds) && asSeconds > 0) return Math.min(asSeconds * 1000, DEFAULT_TIMEOUT_MS);
  return null;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry<T>(url: string, revalidateSeconds: number, attempt = 1): Promise<T> {
  const maxAttempts = 6;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      next: { revalidate: revalidateSeconds },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`TCGTracking API error ${response.status}: ${body}`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const backoff = Math.min(10_000, 800 * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 251);
    await sleep(retryAfterMs ?? backoff + jitter);
    return fetchJsonWithRetry<T>(url, revalidateSeconds, attempt + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempt >= maxAttempts) {
      throw new Error(`TCGTracking fetch failed after ${attempt} attempts: ${message}`);
    }
    const backoff = Math.min(10_000, 800 * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 251);
    await sleep(backoff + jitter);
    return fetchJsonWithRetry<T>(url, revalidateSeconds, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

function selectPreferredPriceNode(priceNode: TcgTrackingPriceNode | null | undefined): {
  subtype: string | null;
  priceFields: TcgTrackingPriceFields | null;
} {
  if (!priceNode?.tcg || !isObject(priceNode.tcg)) {
    return { subtype: null, priceFields: null };
  }

  const entries = Object.entries(priceNode.tcg).filter(([, fields]) => isObject(fields));
  if (entries.length === 0) {
    return { subtype: null, priceFields: null };
  }

  const scored = entries
    .map(([subtype, fields]) => {
      const normalizedSubtype = normalizeSubtype(subtype);
      const preferredIndex = PREFERRED_SUBTYPES.findIndex((candidate) => candidate === normalizedSubtype);
      const values = fields as TcgTrackingPriceFields;
      const priceCount = ["market", "mid", "low", "high"].filter((key) =>
        toOptionalFiniteNumber(values[key as keyof TcgTrackingPriceFields]) !== null
      ).length;
      return {
        subtype,
        fields: values,
        score: (preferredIndex === -1 ? 0 : 100 - preferredIndex * 4) + priceCount * 10,
      };
    })
    .sort((a, b) => b.score - a.score || a.subtype.localeCompare(b.subtype));

  const selected = scored[0];
  return {
    subtype: selected?.subtype ?? null,
    priceFields: selected?.fields ?? null,
  };
}

async function fetchTcgTrackingSearch(cat: number, query: string): Promise<TcgTrackingSetSearchPayload> {
  const params = new URLSearchParams({ q: query });
  const url = `${TCGTRACKING_BASE_URL}/${cat}/search?${params.toString()}`;
  return fetchJsonWithRetry<TcgTrackingSetSearchPayload>(url, FIVE_MINUTES);
}

function scoreTextSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.max(0.82, Math.min(left.length, right.length) / Math.max(left.length, right.length));
  }

  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? overlap / union : 0;
}

function buildSetCandidate(params: {
  set: TcgTrackingSetSummary;
  targetSetName: string | null;
  targetSetCode: string | null;
}): TcgTrackingSetCandidate {
  const { set, targetSetName, targetSetCode } = params;
  const normalizedName = normalizeSetName(set.name);
  const candidateCode = normalizeSetCode(getSetCode(set));
  const targetName = normalizeSetName(targetSetName);
  const targetCode = normalizeSetCode(targetSetCode);
  const similarity = scoreTextSimilarity(normalizedName, targetName);
  const codeMatched = Boolean(targetCode && candidateCode && candidateCode === targetCode);

  let score = 0;
  if (codeMatched) score += 350;
  if (targetName && normalizedName && normalizedName === targetName) score += 320;
  if (targetName && normalizedName && (normalizedName.includes(targetName) || targetName.includes(normalizedName))) score += 180;
  score += Math.round(similarity * 100);

  return {
    id: String(set.id),
    name: toNullableString(set.name),
    code: getSetCode(set),
    year: parseSetYear(set),
    normalizedName,
    score,
    similarity,
    codeMatched,
  };
}

function sortSetCandidates(a: TcgTrackingSetCandidate, b: TcgTrackingSetCandidate): number {
  return (
    b.score - a.score ||
    Number(b.codeMatched) - Number(a.codeMatched) ||
    (b.year ?? 0) - (a.year ?? 0) ||
    b.similarity - a.similarity ||
    (a.name ?? "").localeCompare(b.name ?? "")
  );
}

async function getCachedSearch(cat: number, query: string): Promise<TcgTrackingSetSearchPayload> {
  return unstable_cache(
    () => fetchTcgTrackingSearch(cat, query),
    ["tcgtracking-set-search", String(cat), query.toLowerCase()],
    { revalidate: FIVE_MINUTES }
  )();
}

export async function searchTcgTrackingSets(params: {
  cat: number;
  query: string;
  setName?: string | null;
  setCode?: string | null;
}): Promise<{ query: string; normalizedQuery: string; candidates: TcgTrackingSetCandidate[] }> {
  const query = params.query.trim();
  const payload = await getCachedSearch(params.cat, query);
  const targetSetName = params.setName ?? query;
  const targetSetCode = params.setCode ?? null;

  const candidates = (payload.sets ?? [])
    .map((set) =>
      buildSetCandidate({
        set,
        targetSetName,
        targetSetCode,
      })
    )
    .sort(sortSetCandidates);

  return {
    query,
    normalizedQuery: normalizeSetName(query),
    candidates,
  };
}

export async function resolveTcgTrackingSetDetailed(params: {
  cat: number;
  setCode?: string | null;
  setName?: string | null;
}): Promise<TcgTrackingSetResolution> {
  const queries = buildSetQueryCandidates(params.setCode, params.setName);
  let best: { queryUsed: string; normalizedQuery: string; candidates: TcgTrackingSetCandidate[]; chosen: TcgTrackingSetCandidate } | null = null;

  for (const query of queries) {
    const search = await searchTcgTrackingSets({
      cat: params.cat,
      query,
      setName: params.setName,
      setCode: params.setCode,
    });
    const chosen = search.candidates[0] ?? null;
    if (!chosen) continue;

    if (
      !best ||
      sortSetCandidates(chosen, best.chosen) < 0
    ) {
      best = {
        queryUsed: search.query,
        normalizedQuery: search.normalizedQuery,
        candidates: search.candidates,
        chosen,
      };
    }

    if (chosen.codeMatched || chosen.score >= 420) {
      break;
    }
  }

  if (!best) {
    return {
      queryUsed: queries[0] ?? null,
      normalizedQuery: queries[0] ? normalizeSetName(queries[0]) : null,
      candidates: [],
      chosen: null,
    };
  }

  return {
    queryUsed: best.queryUsed,
    normalizedQuery: best.normalizedQuery,
    candidates: best.candidates,
    chosen: best.chosen,
  };
}

export async function resolveTcgTrackingSet(params: {
  cat: number;
  setCode?: string | null;
  setName?: string | null;
}): Promise<TcgTrackingSetMatch | null> {
  const resolved = await resolveTcgTrackingSetDetailed(params);
  if (!resolved.chosen) return null;

  return {
    id: resolved.chosen.id,
    name: resolved.chosen.name,
    abbr: resolved.chosen.code,
  };
}

async function fetchTcgSetPricing(params: { cat: number; setId: string; limit: number }): Promise<TcgSetPricingPayload> {
  const { cat, setId, limit } = params;
  const baseUrl = `${TCGTRACKING_BASE_URL}/${cat}/sets/${encodeURIComponent(setId)}`;
  const [pricingPayload, productsPayload] = await Promise.all([
    fetchJsonWithRetry<TcgTrackingPricingPayload>(`${baseUrl}/pricing`, ONE_HOUR),
    fetchJsonWithRetry<TcgTrackingProductsPayload>(baseUrl, ONE_DAY).catch(() => null),
  ]);

  const productList = productsPayload?.products ?? [];
  const productsById = new Map(productList.map((product) => [String(product.id), product]));
  const productIds = Array.from(new Set([...productList.map((product) => String(product.id)), ...Object.keys(pricingPayload.prices ?? {})]));

  const items = productIds.slice(0, limit).map((productId) => {
    const product = productsById.get(productId) ?? null;
    const priceNode = pricingPayload.prices?.[productId] ?? null;
    const selected = selectPreferredPriceNode(priceNode);

    return {
      productId,
      name: toNullableString(product?.name) ?? null,
      number: toNullableString(product?.number) ?? null,
      setName: toNullableString(product?.set_name) ?? toNullableString(productsPayload?.set_name) ?? null,
      marketPrice: toOptionalFiniteNumber(selected.priceFields?.market),
      lowPrice: toOptionalFiniteNumber(selected.priceFields?.low),
      midPrice: toOptionalFiniteNumber(selected.priceFields?.mid),
      highPrice: toOptionalFiniteNumber(selected.priceFields?.high),
      currency: "USD",
      updatedAt: toNullableString(priceNode?.updated) ?? toNullableString(pricingPayload.updated) ?? null,
      raw: {
        subtype: selected.subtype,
        pricing: priceNode,
        product,
      },
    } satisfies TcgPricingItem;
  });

  return {
    cat,
    setId,
    setName: toNullableString(productsPayload?.set_name) ?? items[0]?.setName ?? null,
    updatedAt: toNullableString(pricingPayload.updated) ?? items.find((item) => item.updatedAt)?.updatedAt ?? null,
    items,
  };
}

export async function getCachedTcgSetPricing(params: {
  cat: number;
  setId: string;
  limit?: number;
}): Promise<TcgSetPricingPayload> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const setId = params.setId.trim();

  return unstable_cache(
    () =>
      fetchTcgSetPricing({
        cat: params.cat,
        setId,
        limit,
      }),
    ["tcgtracking-set-pricing", String(params.cat), setId, String(limit)],
    { revalidate: ONE_HOUR }
  )();
}

function extractProductRarity(item: TcgPricingItem): string | null {
  if (!isObject(item.raw.product)) return null;
  return (
    toNullableString(item.raw.product.rarity) ??
    toNullableString(item.raw.product.product_rarity) ??
    toNullableString(item.raw.product.print_rarity) ??
    null
  );
}

const OPTIONAL_VARIANT_TOKENS = new Set(["ex", "gx", "v", "vmax", "vstar", "lvx", "lv"]);

function tokenizeName(value: string | null | undefined, stripVariantTokens: boolean): string[] {
  const tokens = normalizePunctuation(value)
    .replace(/\blv x\b/g, "lvx")
    .split(" ")
    .filter(Boolean);

  return stripVariantTokens ? tokens.filter((token) => !OPTIONAL_VARIANT_TOKENS.has(token)) : tokens;
}

function variantTokenSignature(value: string | null | undefined): string {
  return tokenizeName(value, false)
    .filter((token) => OPTIONAL_VARIANT_TOKENS.has(token))
    .sort()
    .join("|");
}

function scoreNameMatch(candidateName: string | null, canonicalName: string): { score: number; similarity: number } {
  const candidateCore = tokenizeName(candidateName, true).join(" ");
  const targetCore = tokenizeName(canonicalName, true).join(" ");
  const candidateRaw = normalizePunctuation(candidateName);
  const targetRaw = normalizePunctuation(canonicalName);
  const similarity = Math.max(scoreTextSimilarity(candidateCore, targetCore), scoreTextSimilarity(candidateRaw, targetRaw));

  let score = Math.round(similarity * 100);
  if (candidateRaw && targetRaw && candidateRaw === targetRaw) score += 120;
  if (candidateCore && targetCore && candidateCore === targetCore) score += 90;
  if (candidateCore && targetCore && (candidateCore.includes(targetCore) || targetCore.includes(candidateCore))) score += 40;
  if (variantTokenSignature(candidateName) && variantTokenSignature(candidateName) === variantTokenSignature(canonicalName)) score += 25;

  return { score, similarity };
}

export function resolveTcgProductMatch(params: {
  items: TcgPricingItem[];
  canonicalName: string;
  canonicalCardNumber?: string | null;
}): TcgProductResolution {
  const { items, canonicalName, canonicalCardNumber } = params;
  const targetNumber = normalizeCardNumber(canonicalCardNumber);
  const targetLeadingNumber = parseLeadingCardNumber(canonicalCardNumber);
  const itemsWithNumber = items.filter((item) => normalizeCardNumber(item.number));
  const itemsWithoutNumber = items.filter((item) => !normalizeCardNumber(item.number));

  const exactNumberMatches = targetNumber
    ? items.filter((item) => {
        const itemNumber = normalizeCardNumber(item.number);
        const itemLeadingNumber = parseLeadingCardNumber(item.number);
        if (!itemNumber) return false;
        return itemNumber === targetNumber || (targetLeadingNumber !== null && itemLeadingNumber === targetLeadingNumber);
      })
    : [];

  let eligibleItems = items;
  let warning: string | null = null;
  let chosenReason: string | null = null;

  if (targetNumber) {
    if (exactNumberMatches.length > 0) {
      eligibleItems = exactNumberMatches;
      chosenReason = `Matched by card number ${canonicalCardNumber}.`;
    } else if (itemsWithNumber.length === 0) {
      warning = "Products in this set do not expose card numbers; fell back to name-only matching.";
      chosenReason = "No product numbers available; used name similarity.";
    } else if (itemsWithoutNumber.length > 0) {
      eligibleItems = itemsWithoutNumber;
      warning = `No exact TCGTracking product number matched ${canonicalCardNumber}; used products without numbers only.`;
      chosenReason = "No exact numbered product match; used name similarity on numberless products.";
    } else {
      warning = `No exact TCGTracking product number matched ${canonicalCardNumber}.`;
      eligibleItems = [];
    }
  }

  const scored = eligibleItems
    .map((item) => {
      const nameMatch = scoreNameMatch(item.name, canonicalName);
      const itemNumber = normalizeCardNumber(item.number);
      const itemLeadingNumber = parseLeadingCardNumber(item.number);
      const numberMatched =
        Boolean(targetNumber) &&
        Boolean(itemNumber) &&
        (itemNumber === targetNumber || (targetLeadingNumber !== null && itemLeadingNumber === targetLeadingNumber));

      let score = nameMatch.score;
      if (numberMatched) score += 250;
      if (item.marketPrice !== null) score += 10;

      return {
        productId: item.productId,
        name: item.name,
        number: item.number,
        rarity: extractProductRarity(item),
        marketPrice: item.marketPrice,
        score,
        nameSimilarity: nameMatch.similarity,
        numberMatched,
        hasNumber: Boolean(itemNumber),
      } satisfies TcgProductMatchCandidate;
    })
    .sort((a, b) => b.score - a.score || Number(b.numberMatched) - Number(a.numberMatched) || b.nameSimilarity - a.nameSimilarity || (a.name ?? "").localeCompare(b.name ?? ""));

  const chosen = scored[0] ?? null;
  if (!chosen && !chosenReason) {
    chosenReason = warning ? "No eligible product after number filter." : "No TCGTracking products returned for this set.";
  } else if (chosen && !chosenReason) {
    chosenReason = chosen.numberMatched ? "Best exact-number product by name similarity." : "Best name similarity fallback.";
  }

  return {
    productsInSet: items.length,
    topCandidates: scored.slice(0, 5),
    chosen,
    chosenReason,
    warning,
  };
}
