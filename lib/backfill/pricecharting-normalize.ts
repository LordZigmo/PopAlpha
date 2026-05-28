export type PriceChartingImportSource = "csv" | "api" | "manual";

export type PriceChartingRawRecord = Record<string, string>;

export type PriceChartingProductUpsertRow = {
  product_id: string;
  product_name: string;
  console_name: string | null;
  genre: string | null;
  release_date: string | null;
  tcg_id: string | null;
  asin: string | null;
  epid: string | null;
  upc: string | null;
  sales_volume: number | null;
  loose_price_usd: number | null;
  grade_7_price_usd: number | null;
  grade_8_price_usd: number | null;
  grade_9_price_usd: number | null;
  grade_9_5_price_usd: number | null;
  grade_10_price_usd: number | null;
  bgs_10_price_usd: number | null;
  cgc_10_price_usd: number | null;
  sgc_10_price_usd: number | null;
  import_source: PriceChartingImportSource;
  observed_at: string;
  raw_payload: PriceChartingRawRecord;
};

export type PriceChartingSkipReason =
  | "MISSING_PRODUCT_ID"
  | "MISSING_PRODUCT_NAME"
  | "NON_POKEMON_CARD";

export type PriceChartingNormalizeResult =
  | { ok: true; row: PriceChartingProductUpsertRow }
  | { ok: false; reason: PriceChartingSkipReason };

const PRICECHARTING_PRICE_FIELDS = {
  loose_price_usd: "loose-price",
  grade_7_price_usd: "cib-price",
  grade_8_price_usd: "new-price",
  grade_9_price_usd: "graded-price",
  grade_9_5_price_usd: "box-only-price",
  grade_10_price_usd: "manual-only-price",
  bgs_10_price_usd: "bgs-10-price",
  cgc_10_price_usd: "condition-17-price",
  sgc_10_price_usd: "condition-18-price",
} as const;

function normalizeHeader(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");
}

function normalizePokemonText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoDate(value: string | null | undefined): string | null {
  const trimmed = cleanText(value);
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed}T00:00:00.000Z`);
  return Number.isFinite(ms) ? trimmed : null;
}

function parseNonNegativeInteger(value: string | null | undefined): number | null {
  const trimmed = cleanText(value);
  if (!trimmed) return null;
  const normalized = trimmed.replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parsePriceChartingCentAmount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return roundUsd(value / 100);
  }

  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const withoutCommas = raw.replace(/,/g, "");
  if (/^\$/.test(withoutCommas)) {
    const dollars = Number.parseFloat(withoutCommas.replace(/^\$/, ""));
    return Number.isFinite(dollars) && dollars > 0 ? roundUsd(dollars) : null;
  }

  if (/^\d+$/.test(withoutCommas)) {
    const cents = Number.parseInt(withoutCommas, 10);
    return cents > 0 ? roundUsd(cents / 100) : null;
  }

  if (/^\d+\.0+$/.test(withoutCommas)) {
    const cents = Number.parseInt(withoutCommas, 10);
    return cents > 0 ? roundUsd(cents / 100) : null;
  }

  return null;
}

export function isLikelyPokemonCardProduct(record: Pick<PriceChartingProductUpsertRow, "product_name" | "console_name" | "genre">): boolean {
  const genre = normalizePokemonText(record.genre);
  return /\bpokemon cards?\b/.test(genre);
}

function normalizeRecordKeys(record: Record<string, unknown>): PriceChartingRawRecord {
  const normalized: PriceChartingRawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[normalizeHeader(key)] = String(value ?? "").trim();
  }
  return normalized;
}

export function normalizePriceChartingProductRecord(params: {
  record: Record<string, unknown>;
  observedAt: string;
  importSource?: PriceChartingImportSource;
  pokemonOnly?: boolean;
}): PriceChartingNormalizeResult {
  const raw = normalizeRecordKeys(params.record);
  const productId = cleanText(raw.id);
  if (!productId) return { ok: false, reason: "MISSING_PRODUCT_ID" };

  const productName = cleanText(raw["product-name"]);
  if (!productName) return { ok: false, reason: "MISSING_PRODUCT_NAME" };

  const row: PriceChartingProductUpsertRow = {
    product_id: productId,
    product_name: productName,
    console_name: cleanText(raw["console-name"]),
    genre: cleanText(raw.genre),
    release_date: parseIsoDate(raw["release-date"]),
    tcg_id: cleanText(raw["tcg-id"]),
    asin: cleanText(raw.asin),
    epid: cleanText(raw.epid),
    upc: cleanText(raw.upc),
    sales_volume: parseNonNegativeInteger(raw["sales-volume"]),
    loose_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.loose_price_usd]),
    grade_7_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.grade_7_price_usd]),
    grade_8_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.grade_8_price_usd]),
    grade_9_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.grade_9_price_usd]),
    grade_9_5_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.grade_9_5_price_usd]),
    grade_10_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.grade_10_price_usd]),
    bgs_10_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.bgs_10_price_usd]),
    cgc_10_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.cgc_10_price_usd]),
    sgc_10_price_usd: parsePriceChartingCentAmount(raw[PRICECHARTING_PRICE_FIELDS.sgc_10_price_usd]),
    import_source: params.importSource ?? "csv",
    observed_at: params.observedAt,
    raw_payload: raw,
  };

  if (params.pokemonOnly !== false && !isLikelyPokemonCardProduct(row)) {
    return { ok: false, reason: "NON_POKEMON_CARD" };
  }

  return { ok: true, row };
}

export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
  return rows;
}

export function parsePriceChartingCsv(csvText: string): PriceChartingRawRecord[] {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return [];

  const headers = rows[0]?.map(normalizeHeader) ?? [];
  return rows.slice(1).map((row) => {
    const record: PriceChartingRawRecord = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = String(row[index] ?? "").trim();
    });
    return record;
  });
}
