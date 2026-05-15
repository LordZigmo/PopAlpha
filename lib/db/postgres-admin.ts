import "server-only";

import fs from "node:fs";
import path from "node:path";
import {
  Client,
  Pool,
  type QueryResultRow,
} from "@neondatabase/serverless";

const DIRECT_CONNECTION_ENV_KEYS = [
  "AI_NEON_DATABASE_URL",
  "POPALPHA_NEON_DATABASE_URL",
  "PopAlpha_NEON_DATABASE_URL",
  "NEON_DATABASE_URL",
  "POPALPHA_POSTGRES_URL_NON_POOLING",
  "PopAlpha_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
  "POPALPHA_DATABASE_URL",
  "PopAlpha_DATABASE_URL",
  "DATABASE_URL",
] as const;

const POOLED_CONNECTION_ENV_KEYS = [
  "POPALPHA_POSTGRES_URL",
  "PopAlpha_POSTGRES_URL",
  "POSTGRES_URL",
] as const;

const DB_PASSWORD_ENV_KEYS = [
  "SUPABASE_DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "PopAlpha_POSTGRES_PASSWORD",
] as const;

const LINKED_POOLER_URL_PATH = path.join(process.cwd(), "supabase", ".temp", "pooler-url");

type AdminPostgresQueryable = {
  end(): Promise<void>;
  query<T extends QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

function resolveConnectionString(keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function resolveDirectAdminPostgresConnectionString(): string | null {
  return resolveConnectionString(DIRECT_CONNECTION_ENV_KEYS);
}

function resolveLinkedPoolerConnectionString(): string | null {
  if (!fs.existsSync(LINKED_POOLER_URL_PATH)) {
    return null;
  }

  const poolerUrl = fs.readFileSync(LINKED_POOLER_URL_PATH, "utf8").trim();
  const dbPassword = resolveConnectionString(DB_PASSWORD_ENV_KEYS);
  if (!poolerUrl || !dbPassword) {
    return null;
  }

  const url = new URL(poolerUrl);
  url.password = dbPassword;
  return url.toString();
}

function resolvePooledAdminPostgresConnectionString(): string | null {
  return resolveLinkedPoolerConnectionString()
    || resolveConnectionString(POOLED_CONNECTION_ENV_KEYS);
}

function summarizeErrorMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function createAdminPostgresQueryable(): Promise<AdminPostgresQueryable> {
  const linkedPoolerConnectionString = resolveLinkedPoolerConnectionString();
  if (linkedPoolerConnectionString) {
    return new Pool({ connectionString: linkedPoolerConnectionString });
  }

  const directConnectionString = resolveDirectAdminPostgresConnectionString();
  if (directConnectionString) {
    const client = new Client({ connectionString: directConnectionString });
    await client.connect();
    return client;
  }

  const pooledConnectionString = resolvePooledAdminPostgresConnectionString();
  if (pooledConnectionString) {
    return new Pool({ connectionString: pooledConnectionString });
  }

  throw new Error(
    "Missing admin Postgres connection string. Set POSTGRES_URL_NON_POOLING, DATABASE_URL, PopAlpha_DATABASE_URL, or a compatible alternate env.",
  );
}

export function hasAdminPostgresConfig(): boolean {
  return resolveDirectAdminPostgresConnectionString() !== null
    || resolvePooledAdminPostgresConnectionString() !== null;
}

export function isRetryableSupabaseEdgeErrorMessage(message: string | null | undefined): boolean {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (!normalized) return false;

  return normalized.includes("error code 521")
    || normalized.includes("error code 522")
    || normalized.includes("error code 523")
    || normalized.includes("error code 524")
    || normalized.includes("error code 525")
    || normalized.includes("error code 530")
    || normalized.includes("cloudflare")
    || normalized.includes("connection timed out")
    || normalized.includes("timed out")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("failed to fetch")
    || normalized.includes("fetch failed")
    || normalized.includes("socket hang up")
    || normalized.includes("econnreset")
    || normalized.includes("econnrefused")
    || normalized.includes("enotfound")
    || normalized.includes("<!doctype html>");
}

export async function queryAdminPostgres<T extends QueryResultRow>(
  queryText: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const client = await createAdminPostgresQueryable();
  try {
    const result = await client.query<T>(queryText, values);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function withAdminPostgresFallback<T>(params: {
  label: string;
  loadFallback: () => Promise<T>;
  loadPrimary: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.loadPrimary();
  } catch (error) {
    const primaryMessage = error instanceof Error ? error.message : String(error);
    if (!hasAdminPostgresConfig() || !isRetryableSupabaseEdgeErrorMessage(primaryMessage)) {
      throw error;
    }

    console.warn(
      `[db-fallback] ${params.label}: Supabase REST failed (${summarizeErrorMessage(primaryMessage)}). Retrying via admin Postgres.`,
    );

    try {
      return await params.loadFallback();
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `${params.label}: Supabase REST failed (${summarizeErrorMessage(primaryMessage)}); `
        + `admin Postgres fallback failed (${summarizeErrorMessage(fallbackMessage)}).`,
      );
    }
  }
}
