import sharedCardSchema from "@/shared_schema.json";

export type SharedCard = {
  id: string;
  name: string;
  set: string | null;
  price: number | null;
};

export type SharedCardSearchResult = SharedCard & {
  canonical_slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  primary_image_url: string | null;
};

export type SharedCardSearchResponse = {
  ok: boolean;
  cards?: SharedCardSearchResult[];
  error?: string;
};

const REQUIRED_FIELDS = new Set(
  Array.isArray((sharedCardSchema as { required?: unknown }).required)
    ? (sharedCardSchema as { required: unknown[] }).required.filter((value): value is string => typeof value === "string")
    : [],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Expected "${key}" to be a string or null.`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readNullableString(record, key);
  if (!value) {
    throw new Error(`Expected "${key}" to be a non-empty string.`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected "${key}" to be a finite number or null.`);
  }
  return value;
}

function ensureRequiredFields(record: Record<string, unknown>) {
  for (const key of REQUIRED_FIELDS) {
    if (!(key in record)) {
      throw new Error(`Missing required shared card field "${key}".`);
    }
  }
}

export function parseSharedCard(value: unknown): SharedCard {
  if (!isRecord(value)) {
    throw new Error("Expected a shared card object.");
  }

  ensureRequiredFields(value);

  return {
    id: readRequiredString(value, "id"),
    name: readRequiredString(value, "name"),
    set: readNullableString(value, "set"),
    price: readNullableNumber(value, "price"),
  };
}

export function parseSharedCardSearchResult(value: unknown): SharedCardSearchResult {
  if (!isRecord(value)) {
    throw new Error("Expected a shared search card object.");
  }

  const sharedCard = parseSharedCard(value);

  return {
    ...sharedCard,
    canonical_slug: readRequiredString(value, "canonical_slug"),
    canonical_name: readRequiredString(value, "canonical_name"),
    set_name: readNullableString(value, "set_name"),
    card_number: readNullableString(value, "card_number"),
    year: readNullableNumber(value, "year"),
    primary_image_url: readNullableString(value, "primary_image_url"),
  };
}

export function parseSharedCardSearchResponse(value: unknown): SharedCardSearchResponse {
  if (!isRecord(value)) {
    throw new Error("Expected the card search response to be an object.");
  }

  const ok = Boolean(value.ok);
  const error = typeof value.error === "string" ? value.error : undefined;
  const cardsValue = value.cards;

  if (cardsValue !== undefined && !Array.isArray(cardsValue)) {
    throw new Error('Expected "cards" to be an array when present.');
  }

  return {
    ok,
    error,
    cards: Array.isArray(cardsValue) ? cardsValue.map(parseSharedCardSearchResult) : undefined,
  };
}
