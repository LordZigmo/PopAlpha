/**
 * PSA pop-report set-page client (Population Tables Phase 2b).
 *
 * PSA's pop report renders set pages from a DataTables-style endpoint:
 *
 *   POST https://www.psacard.com/Pop/GetSetItems
 *   form: headingID=<setPageId>&categoryID=<categoryId>&draw=1&start=0
 *         &length=<pageSize>&isPSADNA=false
 *   → { data: [row, ...], recordsTotal: N }
 *
 * Each row describes one SPEC (SpecID, SubjectName, CardNumber, grade
 * columns, totals) — so a single page fetch enumerates every spec in a
 * set AND carries its current population, costing zero official-API
 * quota. This is the whole-catalog discovery channel; the official
 * GetPSASpecPopulation cron stays the verification/priority lane.
 *
 * VERIFICATION STATUS: endpoint + form shape + row fields are taken from
 * established third-party scrapers (ChrisMuir/psa-scrape et al.), not yet
 * confirmed against a live response from our own egress — PSA fronts
 * www.psacard.com with Cloudflare and may reject datacenter IPs.
 * normalizePopSetRow is therefore deliberately tolerant about key
 * casing/aliases and preserves the raw row verbatim for snapshots. Run
 * scripts/discover-psa-specs.mjs --dry-run from a residential connection
 * first; treat any schema drift as a parser fix, not a matcher fix.
 *
 * Politeness: sequential requests, generous inter-page delay, explicit
 * page caps. Identify via PSA_POP_SCRAPE_USER_AGENT if the default is
 * challenged.
 */

const GET_SET_ITEMS_URL = "https://www.psacard.com/Pop/GetSetItems";
const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGES = 25;
const INTER_PAGE_DELAY_MS = 1500;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export type PopSetRow = {
  specId: number;
  subject: string | null;
  cardNumber: string | null;
  variety: string | null;
  total: number | null;
  /** Numeric population columns exactly as the row carried them
   * (GradeN0..Grade10, GradeTotal, …) — stored verbatim so snapshot
   * consumers can reparse without a re-scrape. */
  gradeCounts: Record<string, number>;
  raw: Record<string, unknown>;
};

export type PopSetFetchResult = {
  rows: PopSetRow[];
  /** Rows the endpoint returned that did not normalize to a spec (the
   * aggregate "totals" row, malformed entries). */
  skippedRows: number;
  recordsTotal: number | null;
  pagesFetched: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickInteger(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }
  return null;
}

const IDENTITY_KEYS = new Set(
  ["specid", "subjectname", "subject", "cardnumber", "variety", "varietyname", "spec", "name"],
);

/**
 * One GetSetItems row → a typed spec row, or null for non-spec rows
 * (PSA's first row is commonly the set-level aggregate without a usable
 * SpecID). Tolerant about key casing; numeric non-identity fields are
 * folded into gradeCounts.
 */
export function normalizePopSetRow(input: unknown): PopSetRow | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;

  const specId = pickInteger(row, ["SpecID", "SpecId", "specID", "specId", "specid"]);
  if (!specId || specId <= 0) return null;

  const gradeCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (IDENTITY_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      gradeCounts[key] = value;
    }
  }
  // The spec id itself is an identity, not a population figure.
  for (const key of Object.keys(gradeCounts)) {
    if (key.toLowerCase() === "specid") delete gradeCounts[key];
  }

  return {
    specId,
    subject: pickString(row, ["SubjectName", "Subject", "subjectName", "subject"]),
    cardNumber: pickString(row, ["CardNumber", "cardNumber", "Number"]),
    variety: pickString(row, ["Variety", "VarietyName", "variety"]),
    total: pickInteger(row, ["Total", "GradeTotal", "total"]),
    gradeCounts,
    raw: row,
  };
}

export async function fetchPopSetItems(params: {
  headingId: number;
  categoryId: number;
  pageSize?: number;
  maxPages?: number;
  interPageDelayMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PopSetFetchResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const pageSize = Math.max(25, Math.min(params.pageSize ?? DEFAULT_PAGE_SIZE, 500));
  const maxPages = Math.max(1, Math.min(params.maxPages ?? MAX_PAGES, MAX_PAGES));
  const delayMs = params.interPageDelayMs ?? INTER_PAGE_DELAY_MS;
  const userAgent = process.env.PSA_POP_SCRAPE_USER_AGENT || DEFAULT_USER_AGENT;

  const rows: PopSetRow[] = [];
  const seenSpecIds = new Set<number>();
  let skippedRows = 0;
  let recordsTotal: number | null = null;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0) await sleep(delayMs);

    const form = new URLSearchParams({
      headingID: String(params.headingId),
      categoryID: String(params.categoryId),
      draw: String(page + 1),
      start: String(page * pageSize),
      length: String(pageSize),
      isPSADNA: "false",
    });

    const response = await fetchImpl(GET_SET_ITEMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "User-Agent": userAgent,
        Referer: "https://www.psacard.com/pop",
      },
      body: form.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `GetSetItems HTTP ${response.status} (headingId=${params.headingId}, page=${page + 1})`,
      );
    }

    const payload = (await response.json()) as {
      data?: unknown[];
      recordsTotal?: number;
    };
    pagesFetched += 1;
    if (typeof payload.recordsTotal === "number") recordsTotal = payload.recordsTotal;

    const pageRows = Array.isArray(payload.data) ? payload.data : [];
    for (const rawRow of pageRows) {
      const normalized = normalizePopSetRow(rawRow);
      if (!normalized) {
        skippedRows += 1;
        continue;
      }
      if (seenSpecIds.has(normalized.specId)) continue;
      seenSpecIds.add(normalized.specId);
      rows.push(normalized);
    }

    if (pageRows.length < pageSize) break;
    if (recordsTotal !== null && rows.length + skippedRows >= recordsTotal) break;
  }

  return { rows, skippedRows, recordsTotal, pagesFetched };
}
