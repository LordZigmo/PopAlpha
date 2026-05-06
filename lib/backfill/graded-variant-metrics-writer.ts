/**
 * Graded variant_metrics writer (Phase 4 of the graded surfacing plan).
 *
 * The RAW analytics pipeline lives in provider-observation-variant-metrics.ts
 * and is RAW-only by design (commit 33cc91b). This writer is its parallel
 * for graded data — it reads from `price_history_points` (the long-format
 * graded variant_refs written continuously by lib/backfill/scrydex-price-
 * history.ts), aggregates per (canonical_slug, printing_id, provider,
 * bucket), computes the same analytics + signals math, and upserts into
 * variant_metrics with the short-form variant_ref the constraint expects.
 *
 * Why this exists:
 *
 *   - Phase 0 finding: variant_metrics graded rows were written in a
 *     single batch on 2026-04-15 03:29 UTC (commit 0be0572's brief
 *     window before 33cc91b reverted graded-through-RAW-pipeline). Since
 *     then the graded rows are frozen — provider_as_of_ts dated 2026-04-
 *     15, 0 of 58,586 have a non-null signal_trend.
 *
 *   - Phase 4 data recon: graded variants now have ~15 history points
 *     each in a 30-day window (median 15, max 19, 93.6% meet the >=10
 *     signal threshold), so per-variant signals are feasible without the
 *     A/B/C tradeoff the original plan flagged.
 *
 *   - Side benefit: refreshing provider_as_of_ts dodges the 2026-05-15
 *     staleness collapse the iOS Grade Board's "Updated X ago" timestamp
 *     was heading toward.
 *
 * Risk surface:
 *
 *   - Writes to variant_metrics at scale. Last time we touched that
 *     table at scale (commit 097b6e0) it caused a silent stall. This
 *     writer batches by slug chunk and logs durationMs + counts per
 *     chunk so the cron route can surface progress.
 *
 *   - Constraint variant_metrics_printing_key_variant_ref_chk requires
 *     graded rows to have variant_ref = `<printing>::<PROVIDER>::<bucket>`
 *     in a specific case mapping (G9 -> '9', G9_5 -> '9_5', G10_PERFECT
 *     -> '10_PERFECT'). The constraint will reject any other shape, so
 *     buildVariantRefForGradedRow MUST stay aligned with the migration
 *     at supabase/migrations/20260416000000_downsample_price_history.sql.
 *
 *   - The signal math here mirrors refresh_derived_signals_for_variants
 *     SQL function. If that SQL changes, mirror the change here too.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseWriteOperation } from "@/lib/backfill/supabase-write-retry";

const SLUG_CHUNK_SIZE = 100;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNAL_POINT_THRESHOLD = 10; // matches refresh_derived_signals_for_variants

const SUPPORTED_PROVIDERS = ["PSA", "CGC", "BGS", "TAG"] as const;
const SUPPORTED_BUCKETS = ["LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"] as const;
type GradedProvider = (typeof SUPPORTED_PROVIDERS)[number];
type GradedBucket = (typeof SUPPORTED_BUCKETS)[number];

const GRADED_VARIANT_REF_PATTERN =
  /^([0-9a-f-]{36})::.*::GRADED::(PSA|CGC|BGS|TAG)::(LE_7|G8|G9|G9_5|G10|G10_PERFECT)::RAW$/;

// variant_metrics short-form variant_ref encoding per the constraint at
// 20260416000000_downsample_price_history.sql:
//   variant_ref = printing_id::text || '::' || upper(provider) || '::' ||
//     case upper(grade)
//       when 'LE_7' then '7_OR_LESS'
//       when 'G8' then '8'
//       when 'G9' then '9'
//       when 'G9_5' then '9_5'
//       when 'G10' then '10'
//       when 'G10_PERFECT' then '10_PERFECT'
//     end
const BUCKET_TO_VARIANT_REF_TOKEN: Record<GradedBucket, string> = {
  LE_7: "7_OR_LESS",
  G8: "8",
  G9: "9",
  G9_5: "9_5",
  G10: "10",
  G10_PERFECT: "10_PERFECT",
};

function buildGradedVariantRef(printingId: string, provider: GradedProvider, bucket: GradedBucket): string {
  return `${printingId}::${provider}::${BUCKET_TO_VARIANT_REF_TOKEN[bucket]}`;
}

type HistoryPoint = {
  ts: string;
  price: number;
};

type GradedHistoryRow = {
  canonical_slug: string;
  variant_ref: string;
  ts: string;
  price: number;
  provider: string;
};

type ParsedGradedRef = {
  printingId: string;
  provider: GradedProvider;
  bucket: GradedBucket;
};

function parseGradedVariantRef(variantRef: string): ParsedGradedRef | null {
  const match = variantRef.match(GRADED_VARIANT_REF_PATTERN);
  if (!match) return null;
  return {
    printingId: match[1],
    provider: match[2] as GradedProvider,
    bucket: match[3] as GradedBucket,
  };
}

// ── Analytics primitives ────────────────────────────────────────────────────
// Mirrors lib/backfill/provider-observation-variant-metrics.ts deriveX()
// functions exactly. If those change, change here too.

function roundMetric(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function deriveTrendSlope7d(points: HistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const latestMs = Date.parse(points[points.length - 1].ts);
  if (!Number.isFinite(latestMs)) return null;
  const cutoffMs = latestMs - SEVEN_DAYS_MS;
  const window = points.filter((p) => {
    const tsMs = Date.parse(p.ts);
    return Number.isFinite(tsMs) && tsMs >= cutoffMs;
  });
  if (window.length < 2) return null;

  const baseMs = Date.parse(window[0].ts);
  if (!Number.isFinite(baseMs)) return null;
  const xs = window.map((p) => (Date.parse(p.ts) - baseMs) / (24 * 60 * 60 * 1000));
  const ys = window.map((p) => p.price);
  const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;

  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return null;
  return roundMetric(num / den);
}

function deriveCovPrice30d(points: HistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const prices = points.map((p) => p.price).filter((v) => v > 0);
  if (prices.length < 2) return null;
  const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
  if (mean <= 0) return null;
  const variance = prices.reduce((s, v) => s + ((v - mean) ** 2), 0) / prices.length;
  return roundMetric(Math.sqrt(variance) / mean);
}

function derivePriceRelativeTo30dRange(points: HistoryPoint[], latestPrice: number | null): number | null {
  if (points.length === 0 || latestPrice === null || latestPrice <= 0) return null;
  const prices = points.map((p) => p.price).filter((v) => v > 0);
  if (prices.length === 0) return null;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) return null;
  return roundMetric((latestPrice - minPrice) / (maxPrice - minPrice));
}

function derivePriceChangesCount30d(points: HistoryPoint[]): number {
  if (points.length < 2) return 0;
  let changes = 0;
  let prev = points[0].price;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i].price - prev) > 1e-9) changes += 1;
    prev = points[i].price;
  }
  return changes;
}

// ── card_metrics analytics primitives ───────────────────────────────────────
// Used by the per-(slug, printing, bucket) and per-(slug, NULL, bucket)
// rollups that fill graded card_metrics rows so the iOS Market Summary
// panel + web Grade Board reference price have data for every card.

function pricesWithin(points: HistoryPoint[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  const out: number[] = [];
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (Number.isFinite(t) && t >= cutoff) out.push(p.price);
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? roundMetric((sorted[mid - 1] + sorted[mid]) / 2)
    : roundMetric(sorted[mid]);
}

function trimmedMedian(values: number[], trimPct: number = 0.1): number | null {
  if (values.length === 0) return null;
  if (values.length < 5) return median(values); // not enough to trim
  const sorted = [...values].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * trimPct);
  const trimmed = sorted.slice(drop, sorted.length - drop);
  return median(trimmed);
}

// ── Signal derivation ──────────────────────────────────────────────────────
// Mirrors public.refresh_derived_signals_for_variants from migration
// 20260301223000_refresh_derived_signals_for_variants.sql exactly.

type DerivedSignals = {
  signal_trend: number | null;
  signal_breakout: number | null;
  signal_value: number | null;
  signals_as_of_ts: string | null;
};

function deriveSignals(args: {
  historyPoints30d: number;
  trendSlope7d: number | null;
  covPrice30d: number | null;
  priceRelativeTo30dRange: number | null;
  priceChangesCount30d: number | null;
}): DerivedSignals {
  const { historyPoints30d, trendSlope7d, covPrice30d, priceRelativeTo30dRange, priceChangesCount30d } = args;
  const meetsThreshold = historyPoints30d >= SIGNAL_POINT_THRESHOLD;

  let trend: number | null = null;
  if (meetsThreshold && trendSlope7d !== null && covPrice30d !== null && covPrice30d !== 0) {
    trend = roundTo(trendSlope7d / covPrice30d, 4);
  }

  let breakout: number | null = null;
  if (meetsThreshold && trendSlope7d !== null && priceRelativeTo30dRange !== null) {
    breakout = roundTo(
      trendSlope7d
        * Math.log(1 + Math.max(priceChangesCount30d ?? 0, 0))
        * (1 - priceRelativeTo30dRange),
      4,
    );
  }

  let value: number | null = null;
  if (meetsThreshold && priceRelativeTo30dRange !== null) {
    value = roundTo((1 - priceRelativeTo30dRange) * 100, 2);
  }

  return {
    signal_trend: trend,
    signal_breakout: breakout,
    signal_value: value,
    signals_as_of_ts: meetsThreshold ? new Date().toISOString() : null,
  };
}

function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ── Main orchestrator ─────────────────────────────────────────────────────

export type GradedWriterResult = {
  ok: boolean;
  durationMs: number;
  scope: string;
  slugsScanned: number;
  graded_history_rows_loaded: number;
  groupsComputed: number;
  variant_metrics_upserted: number;
  signals_with_full_threshold: number;
  /**
   * card_metrics graded rows upserted (per-printing rows + canonical
   * `printing_id IS NULL` aggregate rows). Closes the ~17%-of-catalog
   * Market Summary coverage gap (3,200 slugs that previously had
   * graded variant_metrics + price_history_points rows but zero
   * card_metrics graded rows).
   */
  card_metrics_upserted: number;
  firstError: string | null;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

/**
 * Run the graded analytics writer, optionally scoped to a slug pattern.
 *
 * @param slugPattern  Postgres ilike pattern (e.g. `"scarlet-violet-1-%"`)
 *                     or null to process every canonical_cards slug. Used
 *                     for canary runs.
 * @param maxSlugs     Hard cap on number of slugs in this run; prevents
 *                     unbounded memory if the pattern matches more than
 *                     expected. Defaults to 200.
 */
export async function runGradedVariantMetricsWriter(args: {
  supabase: SupabaseClient;
  slugPattern?: string | null;
  maxSlugs?: number;
  logger?: Logger;
}): Promise<GradedWriterResult> {
  const startedAt = Date.now();
  const log = args.logger ?? console;
  const supabase = args.supabase;
  const cutoff30dIso = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  let firstError: string | null = null;
  let slugsScanned = 0;
  let graded_history_rows_loaded = 0;
  let groupsComputed = 0;
  let variant_metrics_upserted = 0;
  let signals_with_full_threshold = 0;
  let card_metrics_upserted = 0;

  // 1. Resolve scope. We pull slugs from canonical_cards rather than
  // from price_history_points so the caller can run "process this set"
  // even if the set has no graded data yet (in which case this is a no-op).
  const slugQuery = supabase.from("canonical_cards").select("slug");
  if (args.slugPattern) slugQuery.like("slug", args.slugPattern);
  const slugQueryFinal = slugQuery.limit(args.maxSlugs ?? 200);
  const { data: slugRows, error: slugErr } = await slugQueryFinal;
  if (slugErr) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      scope: args.slugPattern ?? "<all>",
      slugsScanned: 0,
      graded_history_rows_loaded: 0,
      groupsComputed: 0,
      variant_metrics_upserted: 0,
      signals_with_full_threshold: 0,
      card_metrics_upserted: 0,
      firstError: `canonical_cards select failed: ${slugErr.message}`,
    };
  }
  const allSlugs = (slugRows ?? []).map((r) => (r as { slug: string }).slug).filter(Boolean);

  log.info(`[graded-vm-writer] scope=${args.slugPattern ?? "<all>"} slugs=${allSlugs.length}`);

  // 2. Process in chunks.
  for (let i = 0; i < allSlugs.length; i += SLUG_CHUNK_SIZE) {
    const chunk = allSlugs.slice(i, i + SLUG_CHUNK_SIZE);
    slugsScanned += chunk.length;

    // 2a. Fetch graded history points for this chunk in last 30d.
    // PostgREST caps default page size at 1000 rows. A chunk of 100 slugs
    // averaging ~30 graded points each easily exceeds that, so we page
    // explicitly to avoid silently dropping points (which would skew
    // median/low/high downstream). Bounded at 50k rows per chunk so a
    // pathological set can't blow memory.
    const PAGE = 1000;
    const HIST_HARD_CAP = 50_000;
    const histRows: GradedHistoryRow[] = [];
    let pagedFetchError: string | null = null;
    for (let from = 0; from < HIST_HARD_CAP; from += PAGE) {
      const { data: pageRowsRaw, error: pageErr } = await supabase
        .from("price_history_points")
        .select("canonical_slug, variant_ref, ts, price, provider")
        .in("canonical_slug", chunk)
        .like("variant_ref", "%::GRADED::%")
        .gte("ts", cutoff30dIso)
        .order("ts", { ascending: true })
        .range(from, from + PAGE - 1);
      if (pageErr) {
        pagedFetchError = pageErr.message;
        break;
      }
      const batch = (pageRowsRaw ?? []) as GradedHistoryRow[];
      histRows.push(...batch);
      if (batch.length < PAGE) break;
    }
    if (pagedFetchError) {
      firstError = firstError ?? `price_history_points select failed (chunk ${i}): ${pagedFetchError}`;
      log.error(`[graded-vm-writer] chunk ${i} fetch error: ${pagedFetchError}`);
      continue;
    }
    graded_history_rows_loaded += histRows.length;

    // 2b. Group by (canonical_slug, printingId, provider, bucket).
    const groups = new Map<
      string,
      { canonicalSlug: string; printingId: string; provider: GradedProvider; bucket: GradedBucket; points: HistoryPoint[] }
    >();
    for (const row of histRows) {
      const parsed = parseGradedVariantRef(row.variant_ref);
      if (!parsed) continue;
      if (!Number.isFinite(row.price) || row.price <= 0) continue;
      const key = `${row.canonical_slug}::${parsed.printingId}::${parsed.provider}::${parsed.bucket}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          canonicalSlug: row.canonical_slug,
          printingId: parsed.printingId,
          provider: parsed.provider,
          bucket: parsed.bucket,
          points: [],
        };
        groups.set(key, group);
      }
      group.points.push({ ts: row.ts, price: row.price });
    }

    if (groups.size === 0) continue;
    groupsComputed += groups.size;

    // 2c. Compute analytics + signals per group, build write rows.
    const writes: Array<Record<string, unknown>> = [];
    const nowIso = new Date().toISOString();
    for (const group of groups.values()) {
      // Points are already ts-asc from the query.
      const trend = deriveTrendSlope7d(group.points);
      const cov = deriveCovPrice30d(group.points);
      const latestPrice = group.points[group.points.length - 1]?.price ?? null;
      const priceRel = derivePriceRelativeTo30dRange(group.points, latestPrice);
      const changes = derivePriceChangesCount30d(group.points);
      const signals = deriveSignals({
        historyPoints30d: group.points.length,
        trendSlope7d: trend,
        covPrice30d: cov,
        priceRelativeTo30dRange: priceRel,
        priceChangesCount30d: changes,
      });
      if (signals.signal_trend !== null) signals_with_full_threshold += 1;

      const variantRef = buildGradedVariantRef(group.printingId, group.provider, group.bucket);
      const latestTs = group.points[group.points.length - 1]?.ts ?? nowIso;

      writes.push({
        canonical_slug: group.canonicalSlug,
        printing_id: group.printingId,
        variant_ref: variantRef,
        provider: group.provider,
        grade: group.bucket,
        provider_trend_slope_7d: trend,
        provider_cov_price_30d: cov,
        provider_price_relative_to_30d_range: priceRel,
        provider_price_changes_count_30d: changes,
        provider_as_of_ts: latestTs,
        history_points_30d: group.points.length,
        signal_trend: signals.signal_trend,
        signal_breakout: signals.signal_breakout,
        signal_value: signals.signal_value,
        signals_as_of_ts: signals.signals_as_of_ts,
        updated_at: nowIso,
      });
    }

    // 2d. Upsert with retry. Conflict target matches the unique index on
    // (canonical_slug, variant_ref, provider, grade) — see migration
    // 20260301140000_variant_metrics.sql.
    try {
      const data = await retrySupabaseWriteOperation(
        "graded_variant_metrics(upsert)",
        async () => {
          const { data, error } = await supabase
            .from("variant_metrics")
            .upsert(writes, { onConflict: "canonical_slug,variant_ref,provider,grade" })
            .select("id");
          if (error) throw new Error(error.message);
          return (data ?? []) as Array<{ id: string }>;
        },
      );
      variant_metrics_upserted += data.length;
      log.info(`[graded-vm-writer] chunk ${i} upserted ${data.length} rows (${groups.size} groups, ${histRows.length} hist rows)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError = firstError ?? `upsert failed (chunk ${i}): ${msg}`;
      log.error(`[graded-vm-writer] chunk ${i} upsert error: ${msg}`);
    }

    // 2e. card_metrics rollup. Two grouping levels per (slug, bucket):
    //   - per-printing: keyed (slug, printing_id, bucket); aggregates
    //     across providers within that printing.
    //   - canonical: keyed (slug, NULL, bucket); aggregates across all
    //     printings for that bucket. Required so iOS Market Summary's
    //     "prefer canonical, fall back to printing-scoped" picker has a
    //     row to lock onto for cards that don't have a printing already
    //     selected by the time the panel renders.
    const cmGroups = new Map<
      string,
      { canonicalSlug: string; printingId: string | null; bucket: GradedBucket; points: HistoryPoint[] }
    >();
    for (const row of histRows) {
      const parsed = parseGradedVariantRef(row.variant_ref);
      if (!parsed) continue;
      if (!Number.isFinite(row.price) || row.price <= 0) continue;
      const point: HistoryPoint = { ts: row.ts, price: row.price };

      const printingKey = `${row.canonical_slug}::${parsed.printingId}::${parsed.bucket}`;
      let pg = cmGroups.get(printingKey);
      if (!pg) {
        pg = { canonicalSlug: row.canonical_slug, printingId: parsed.printingId, bucket: parsed.bucket, points: [] };
        cmGroups.set(printingKey, pg);
      }
      pg.points.push(point);

      const canonicalKey = `${row.canonical_slug}::NULL::${parsed.bucket}`;
      let cg = cmGroups.get(canonicalKey);
      if (!cg) {
        cg = { canonicalSlug: row.canonical_slug, printingId: null, bucket: parsed.bucket, points: [] };
        cmGroups.set(canonicalKey, cg);
      }
      cg.points.push(point);
    }

    if (cmGroups.size > 0) {
      const cmWrites: Array<Record<string, unknown>> = [];
      for (const g of cmGroups.values()) {
        const w7 = pricesWithin(g.points, 7 * 24 * 60 * 60 * 1000);
        const w30 = pricesWithin(g.points, THIRTY_DAYS_MS);
        if (w30.length === 0) continue;
        cmWrites.push({
          canonical_slug: g.canonicalSlug,
          printing_id: g.printingId,
          grade: g.bucket,
          median_7d: median(w7),
          median_30d: median(w30),
          low_30d: Math.min(...w30),
          high_30d: Math.max(...w30),
          trimmed_median_30d: trimmedMedian(w30),
          snapshot_count_30d: w30.length,
          updated_at: nowIso,
        });
      }

      if (cmWrites.length > 0) {
        try {
          const data = await retrySupabaseWriteOperation(
            "graded_card_metrics(upsert)",
            async () => {
              const { data, error } = await supabase
                .from("card_metrics")
                // NULLS NOT DISTINCT on the unique index means
                // (slug, NULL, bucket) is one stable row, not duplicated.
                .upsert(cmWrites, { onConflict: "canonical_slug,printing_id,grade" })
                .select("id");
              if (error) throw new Error(error.message);
              return (data ?? []) as Array<{ id: string }>;
            },
          );
          card_metrics_upserted += data.length;
          log.info(`[graded-cm-writer] chunk ${i} upserted ${data.length} card_metrics rows`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          firstError = firstError ?? `card_metrics upsert failed (chunk ${i}): ${msg}`;
          log.error(`[graded-cm-writer] chunk ${i} upsert error: ${msg}`);
        }
      }
    }
  }

  return {
    ok: firstError === null,
    durationMs: Date.now() - startedAt,
    scope: args.slugPattern ?? "<all>",
    slugsScanned,
    graded_history_rows_loaded,
    groupsComputed,
    variant_metrics_upserted,
    signals_with_full_threshold,
    card_metrics_upserted,
    firstError,
  };
}
