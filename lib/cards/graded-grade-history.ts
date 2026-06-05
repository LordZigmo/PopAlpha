import type { dbPublic } from "@/lib/db";
import { GRADE_BUCKETS, type GradeBucket, type GradedProvider } from "@/lib/cards/detail-types";
import {
  convertPriceHistoryRowToUsd,
  loadPriceHistoryFxRows,
} from "@/lib/pricing/price-history-currency";

export type GradedGradeSeries = {
  grade: GradeBucket;
  points: { ts: string; price: number }[];
};

type GradedHistoryRow = {
  variant_ref: string;
  price: number;
  currency: string | null;
  ts: string;
};

// Long-form graded ref: `<printing>::<provVarId>::GRADED::<PROVIDER>::<BUCKET>::RAW`.
// Mirrors the parser used on the card detail page for the single-bucket query.
const GRADED_LONG_REF_RE =
  /^[0-9a-f-]{36}::.*::GRADED::(PSA|CGC|BGS|TAG)::(LE_7|G8|G9|G9_5|G10|G10_PERFECT)::RAW$/;

// High → low so the legend / overlay reads top grade first.
const GRADE_DISPLAY_ORDER: GradeBucket[] = [
  "G10_PERFECT",
  "G10",
  "G9_5",
  "G9",
  "G8",
  "LE_7",
];

function toIsoDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Per-grade price history for one printing + grader, across every grade
 * bucket that has data. Powers the GRADED multi-line overlay so collectors
 * can see which grade is moving quicker relative to the others.
 *
 * Reuses the proven `public_price_history` query shape from the card detail
 * page (provider=SCRYDEX, source_window=snapshot, grader matched via the
 * long-form variant_ref), but anchors on a single grader across ALL buckets
 * instead of a single bucket across all graders.
 */
export async function loadGradedGradeHistory(params: {
  supabase: ReturnType<typeof dbPublic>;
  canonicalSlug: string;
  printingId: string;
  provider: GradedProvider;
  days?: number;
}): Promise<GradedGradeSeries[]> {
  const { supabase, canonicalSlug, printingId, provider } = params;
  const days = params.days ?? 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const pageSize = 1000;
  const rows: GradedHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("public_price_history")
      .select("variant_ref, price, currency, ts")
      .eq("canonical_slug", canonicalSlug)
      .eq("provider", "SCRYDEX")
      .eq("source_window", "snapshot")
      .ilike("variant_ref", `${printingId}::%::GRADED::${provider}::%::RAW`)
      .gte("ts", since)
      .order("ts", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`graded grade history query failed: ${error.message}`);
    const batch = (data ?? []) as GradedHistoryRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  if (rows.length === 0) return [];

  const maxDate = rows
    .map((row) => toIsoDate(row.ts))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const fxRows = await loadPriceHistoryFxRows(supabase, maxDate);

  // grade -> (isoDate -> price). De-dupe to one observation per day so a
  // busy snapshot day doesn't over-weight the line.
  const byGrade = new Map<GradeBucket, Map<string, number>>();
  for (const row of rows) {
    if (!row.variant_ref) continue;
    const match = row.variant_ref.match(GRADED_LONG_REF_RE);
    if (!match) continue;
    const bucket = match[2] as GradeBucket;
    const usd = convertPriceHistoryRowToUsd(row, fxRows);
    if (usd === null || usd <= 0) continue;
    const day = toIsoDate(row.ts);
    if (!day) continue;
    const series = byGrade.get(bucket) ?? new Map<string, number>();
    series.set(day, usd);
    byGrade.set(bucket, series);
  }

  return GRADE_DISPLAY_ORDER.filter((grade) => (byGrade.get(grade)?.size ?? 0) >= 2).map((grade) => {
    const dayMap = byGrade.get(grade)!;
    const points = [...dayMap.entries()]
      .map(([day, price]) => ({ ts: `${day}T00:00:00.000Z`, price }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    return { grade, points };
  });
}

export const GRADE_BUCKET_ORDER = GRADE_BUCKETS;
