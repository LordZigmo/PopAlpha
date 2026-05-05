#!/usr/bin/env node
/**
 * One-off coverage report: how much graded pricing reaches users?
 *
 * Strategy: do ONE estimated count for total table size (fast), then
 * fetch only the (small) graded subset paginated and aggregate client-side.
 * This avoids dozens of slow `count: 'exact'` queries on millions of RAW rows.
 *
 * Run: node --env-file=.env.local scripts/report-graded-pricing-coverage.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
// Filename is derived from generatedAt at runtime so historical snapshots
// accumulate rather than overwriting one another. Curated narrative
// findings live in docs/graded-surfacing-plan.md, not in the auto-generated
// report — that file is pure data.

const GRADE_BUCKETS = ["RAW", "LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"];
const GRADED_BUCKETS = GRADE_BUCKETS.filter((g) => g !== "RAW");
const PROVIDERS = ["PSA", "CGC", "BGS", "TAG"];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createSupabase() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const startTs = Date.now();
function log(...args) {
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(`[+${elapsed}s]`, ...args);
}

/** Cheap planned-stats count via pg_class. */
async function plannedCount(supabase, table, filterFn = (q) => q) {
  const { count, error } = await filterFn(
    supabase.from(table).select("*", { count: "estimated", head: true }),
  );
  if (error) throw new Error(`plannedCount(${table}): ${error.message}`);
  return count ?? 0;
}

/** Exact count — only call when table is small or filter is highly selective. */
async function exactCount(supabase, table, filterFn = (q) => q) {
  const { count, error } = await filterFn(
    supabase.from(table).select("*", { count: "exact", head: true }),
  );
  if (error) throw new Error(`exactCount(${table}): ${error.message}`);
  return count ?? 0;
}

/** Page through and collect rows of one or more selected columns. */
async function fetchAll(supabase, table, columns, filterFn = (q) => q, hardCap = 500_000) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; from < hardCap; from += PAGE) {
    const { data, error } = await filterFn(
      supabase.from(table).select(columns).range(from, from + PAGE - 1),
    );
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const supabase = createSupabase();
  const generatedAt = new Date().toISOString();
  log(`starting graded coverage report at ${generatedAt}`);

  // ── Layer 1: ingestion (provider_normalized_observations) ─────────────────
  // We DON'T enumerate the 2M+ graded rows — the table has the highest cardinality
  // in the system. Instead: total counts + 4 cheap LIKE-filtered counts for provider
  // breakdown. Distinct provider_card_id is approximated via a 50k sample.
  log("layer 1: provider_normalized_observations totals");
  const obsTotalAll = await plannedCount(supabase, "provider_normalized_observations");
  const obsGradedTotal = await exactCount(supabase, "provider_normalized_observations", (q) =>
    q.eq("normalized_condition", "graded"),
  );
  log(`  total ~${obsTotalAll}, graded=${obsGradedTotal}`);

  log("layer 1: provider breakdown via LIKE on provider_variant_id");
  const obsGradedByProvider = {};
  for (const p of PROVIDERS) {
    obsGradedByProvider[p] = await exactCount(supabase, "provider_normalized_observations", (q) =>
      q.eq("normalized_condition", "graded").like("provider_variant_id", `%::GRADED::${p}::%`),
    );
    log(`    ${p}: ${obsGradedByProvider[p]}`);
  }

  log("layer 1: distinct provider_card_id (50k sample)");
  const obsSample = await fetchAll(
    supabase,
    "provider_normalized_observations",
    "provider_card_id",
    (q) => q.eq("normalized_condition", "graded"),
    50_000,
  );
  const obsDistinctProviderCards = new Set();
  for (const r of obsSample) {
    if (r.provider_card_id) obsDistinctProviderCards.add(r.provider_card_id);
  }
  log(`  sampled ${obsSample.length} rows, ${obsDistinctProviderCards.size} distinct provider_card_id`);

  // ── Layer 2: price_snapshots ──────────────────────────────────────────────
  log("layer 2: price_snapshots totals");
  const snapTotalAll = await plannedCount(supabase, "price_snapshots");
  const snapRawTotal = await exactCount(supabase, "price_snapshots", (q) => q.eq("grade", "RAW"));
  log(`  total ~${snapTotalAll}, RAW=${snapRawTotal}`);

  log("layer 2: per-bucket exact counts");
  const snapByGrade = { RAW: snapRawTotal };
  for (const g of GRADED_BUCKETS) {
    snapByGrade[g] = await exactCount(supabase, "price_snapshots", (q) => q.eq("grade", g));
    log(`    ${g}: ${snapByGrade[g]}`);
  }
  const snapGradedTotal = GRADED_BUCKETS.reduce((a, g) => a + (snapByGrade[g] || 0), 0);

  log("layer 2: distinct slugs with graded snapshots (50k sample) + most-recent observed_at");
  const snapSample = await fetchAll(
    supabase,
    "price_snapshots",
    "canonical_slug, observed_at",
    (q) => q.in("grade", GRADED_BUCKETS).order("observed_at", { ascending: false }),
    50_000,
  );
  const snapDistinctSlugsGraded = new Set();
  let snapMostRecentGraded = null;
  for (const r of snapSample) {
    if (r.canonical_slug) snapDistinctSlugsGraded.add(r.canonical_slug);
    if (r.observed_at && (!snapMostRecentGraded || r.observed_at > snapMostRecentGraded)) {
      snapMostRecentGraded = r.observed_at;
    }
  }
  log(`  sampled ${snapSample.length} graded snapshots, ${snapDistinctSlugsGraded.size} distinct slugs`);

  // ── Layer 3a: card_metrics (per slug × printing × grade) ──────────────────
  log("layer 3a: card_metrics");
  const cmRows = await fetchAll(
    supabase,
    "card_metrics",
    "canonical_slug, grade",
    (q) => q.in("grade", GRADED_BUCKETS),
  );
  const cmRawTotal = await exactCount(supabase, "card_metrics", (q) => q.eq("grade", "RAW"));
  const cmByGrade = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));
  cmByGrade.RAW = cmRawTotal;
  const cmDistinctSlugsGraded = new Set();
  for (const r of cmRows) {
    cmByGrade[r.grade] = (cmByGrade[r.grade] || 0) + 1;
    if (r.canonical_slug) cmDistinctSlugsGraded.add(r.canonical_slug);
  }
  const cmGradedTotal = cmRows.length;
  log(`  graded rows=${cmGradedTotal} across ${cmDistinctSlugsGraded.size} slugs; RAW=${cmRawTotal}`);

  // ── Layer 3b: variant_metrics (the iOS/web Grade Board read source) ───────
  log("layer 3b: variant_metrics");
  const vmRawTotal = await exactCount(supabase, "variant_metrics", (q) => q.eq("grade", "RAW"));
  const vmGradedRows = await fetchAll(
    supabase,
    "variant_metrics",
    "canonical_slug, provider, grade, history_points_30d, signal_trend, provider_as_of_ts",
    (q) => q.neq("grade", "RAW"),
  );
  const vmGradedByProviderBucket = {};
  for (const p of PROVIDERS) {
    vmGradedByProviderBucket[p] = Object.fromEntries(GRADED_BUCKETS.map((g) => [g, 0]));
  }
  const vmDistinctSlugsGraded = new Set();
  // history_points_30d is an INTEGER count, not a JSONB array.
  let vmGradedWithPoints = 0;
  let vmGradedWithSignal = 0;
  let vmGradedFresh30d = 0;
  let vmLatestProviderAsOfTs = null;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const r of vmGradedRows) {
    if (vmGradedByProviderBucket[r.provider]) {
      vmGradedByProviderBucket[r.provider][r.grade] =
        (vmGradedByProviderBucket[r.provider][r.grade] || 0) + 1;
    }
    if (r.canonical_slug) vmDistinctSlugsGraded.add(r.canonical_slug);
    if ((r.history_points_30d ?? 0) > 0) vmGradedWithPoints += 1;
    if (r.signal_trend != null) vmGradedWithSignal += 1;
    if (r.provider_as_of_ts) {
      if (new Date(r.provider_as_of_ts).getTime() >= cutoff) vmGradedFresh30d += 1;
      if (!vmLatestProviderAsOfTs || r.provider_as_of_ts > vmLatestProviderAsOfTs) {
        vmLatestProviderAsOfTs = r.provider_as_of_ts;
      }
    }
  }
  const vmGradedTotal = vmGradedRows.length;
  const vmLatestStalenessHours = vmLatestProviderAsOfTs
    ? Math.round((Date.now() - new Date(vmLatestProviderAsOfTs).getTime()) / 36e5)
    : null;
  log(`  graded rows=${vmGradedTotal}, ${vmDistinctSlugsGraded.size} distinct slugs; RAW=${vmRawTotal}`);
  log(`    history_points_30d > 0: ${vmGradedWithPoints} (${((vmGradedWithPoints / vmGradedTotal) * 100).toFixed(1)}%)`);
  log(`    signal_trend not null: ${vmGradedWithSignal} (signals require >=10 points; mostly nulled for graded)`);
  log(`    provider_as_of_ts within 30d: ${vmGradedFresh30d}`);
  log(`    latest provider_as_of_ts: ${vmLatestProviderAsOfTs} (${vmLatestStalenessHours}h ago)`);

  log("layer 3b: public_variant_metrics (the user-visible view)");
  const pvmGradedRows = await fetchAll(
    supabase,
    "public_variant_metrics",
    "canonical_slug, provider, grade",
    (q) => q.neq("grade", "RAW"),
  );
  const pvmDistinctSlugsGraded = new Set(
    pvmGradedRows.map((r) => r.canonical_slug).filter(Boolean),
  );
  log(`  user-visible graded rows=${pvmGradedRows.length} across ${pvmDistinctSlugsGraded.size} slugs`);

  // ── Layer 4: PSA certificates (separate path) ─────────────────────────────
  log("layer 4: psa_certificates");
  const psaCertCount = await plannedCount(supabase, "psa_certificates");
  const vmPsaTotal = await exactCount(supabase, "variant_metrics", (q) => q.eq("provider", "PSA"));

  // ── Layer 5: drop-off, snapshot → user-visible ────────────────────────────
  const dropOffSnapToPublic = setDifferenceSize(snapDistinctSlugsGraded, pvmDistinctSlugsGraded);

  // ── Layer 6: holdings mis-valuation sample ────────────────────────────────
  log("layer 6: holdings");
  const holdingsTotal = await plannedCount(supabase, "holdings");
  const holdingsRows = await fetchAll(
    supabase,
    "holdings",
    "id, canonical_slug, printing_id, grade, qty, price_paid_usd",
    (q) => q.not("canonical_slug", "is", null),
  );
  let holdingsGradedTotal = 0;
  let holdingsRawTotal = 0;
  let holdingsNullGradeTotal = 0;
  const gradedHoldings = [];
  for (const h of holdingsRows) {
    if (h.grade == null) holdingsNullGradeTotal += 1;
    else if (isHoldingRaw(h.grade)) holdingsRawTotal += 1;
    else {
      holdingsGradedTotal += 1;
      gradedHoldings.push(h);
    }
  }
  log(`  total ~${holdingsTotal}; raw=${holdingsRawTotal}, graded=${holdingsGradedTotal}, null=${holdingsNullGradeTotal}`);

  // Sample up to 10 distinct (slug, grade) graded holdings, look up RAW market_price
  // (what /api/holdings/summary serves) and graded variant_metrics history.
  const sample = [];
  const seenKeys = new Set();
  for (const h of gradedHoldings) {
    const key = `${h.canonical_slug}::${h.grade}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (sample.length >= 10) break;

    const { data: rawMetric } = await supabase
      .from("public_card_metrics")
      .select("market_price")
      .eq("canonical_slug", h.canonical_slug)
      .eq("grade", "RAW")
      .limit(1)
      .maybeSingle();

    const expectedBucket = normalizeHoldingGrade(h.grade);
    const { data: gradedRows } = await supabase
      .from("variant_metrics")
      .select("provider, grade, history_points_30d, provider_as_of_ts")
      .eq("canonical_slug", h.canonical_slug)
      .eq("grade", expectedBucket)
      .limit(5);

    const latestGraded = pickLatestPriceFromVariantMetrics(gradedRows ?? []);
    sample.push({
      slug: h.canonical_slug,
      grade: h.grade,
      qty: h.qty,
      pricePaidUsd: h.price_paid_usd,
      rawMarketPrice: rawMetric?.market_price ?? null,
      gradedMarketPrice: latestGraded.price,
      gradedProvider: latestGraded.provider,
      gradedAvailable: latestGraded.price != null,
    });
  }

  // ── Tropical Beach BW28 spot-check ────────────────────────────────────────
  log("verification: Tropical Beach BW28");
  const tropicalBeach = await spotCheckCard(supabase);

  // ── Render report ─────────────────────────────────────────────────────────
  log("rendering report");
  const report = renderReport({
    generatedAt,
    layer1: {
      gradedTotal: obsGradedTotal,
      gradedTotalAll: obsTotalAll,
      gradedByProvider: obsGradedByProvider,
      distinctProviderCards: obsDistinctProviderCards.size,
    },
    layer2: {
      byGrade: snapByGrade,
      gradedTotal: snapGradedTotal,
      rawTotal: snapRawTotal,
      distinctSlugsGraded: snapDistinctSlugsGraded.size,
      mostRecentGraded: snapMostRecentGraded,
    },
    layer3a: {
      byGrade: cmByGrade,
      gradedTotal: cmGradedTotal,
      rawTotal: cmRawTotal,
      distinctSlugsGraded: cmDistinctSlugsGraded.size,
    },
    layer3b: {
      gradedByProviderBucket: vmGradedByProviderBucket,
      gradedTotal: vmGradedTotal,
      rawTotal: vmRawTotal,
      distinctSlugsGradedVariantMetrics: vmDistinctSlugsGraded.size,
      distinctSlugsGradedPublicView: pvmDistinctSlugsGraded.size,
      gradedWithPoints: vmGradedWithPoints,
      gradedWithSignal: vmGradedWithSignal,
      gradedFresh30d: vmGradedFresh30d,
      latestGradedProviderAsOfTs: vmLatestProviderAsOfTs,
      latestGradedStalenessHours: vmLatestStalenessHours,
    },
    layer4: { psaCertCount, vmPsaTotal },
    layer5: {
      slugsAtSnapshot: snapDistinctSlugsGraded.size,
      slugsAtPublicView: pvmDistinctSlugsGraded.size,
      dropOff: dropOffSnapToPublic,
    },
    layer6: {
      gradedHoldings: holdingsGradedTotal,
      rawHoldings: holdingsRawTotal,
      nullGradeHoldings: holdingsNullGradeTotal,
      sample,
    },
    spotCheck: tropicalBeach,
  });

  const reportDate = generatedAt.slice(0, 10); // YYYY-MM-DD from ISO timestamp
  const reportPath = path.join(REPO_ROOT, "docs", `graded-pricing-coverage-${reportDate}.md`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  log(`wrote ${reportPath}`);
}

function setDifferenceSize(a, b) {
  let diff = 0;
  for (const v of a) if (!b.has(v)) diff += 1;
  return diff;
}

function isHoldingRaw(grade) {
  if (!grade) return false;
  const g = String(grade).trim().toUpperCase();
  if (g === "RAW") return true;
  if (g.startsWith("NM") || g.startsWith("LP") || g.startsWith("MP") || g.startsWith("HP") || g.startsWith("DMG")) return true;
  return false;
}

function normalizeHoldingGrade(holdingGrade) {
  if (!holdingGrade) return "RAW";
  const m = String(holdingGrade).match(/(\d+(?:\.\d+)?)/);
  if (!m) return holdingGrade;
  const n = parseFloat(m[1]);
  if (n >= 10) return "G10";
  if (n >= 9.5) return "G9_5";
  if (n >= 9) return "G9";
  if (n >= 8) return "G8";
  return "LE_7";
}

function pickLatestPriceFromVariantMetrics(rows) {
  let best = { price: null, provider: null, asOf: null };
  for (const r of rows) {
    const points = Array.isArray(r.history_points_30d) ? r.history_points_30d : [];
    const latest = points
      .filter((p) => p && typeof p === "object" && Number.isFinite(p.price))
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
    if (latest && (best.price == null || new Date(latest.ts) > new Date(best.asOf))) {
      best = { price: latest.price, provider: r.provider, asOf: latest.ts };
    }
  }
  return best;
}

async function spotCheckCard(supabase) {
  const { data: candidates } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name")
    .ilike("slug", "%tropical-beach%")
    .limit(20);
  const target = (candidates ?? []).find((s) => /bw28|black-white-promos|promo/.test(s.slug.toLowerCase()))
    || (candidates ?? [])[0]
    || null;
  if (!target) return { found: false };

  const obsGraded = await exactCount(supabase, "provider_normalized_observations", (q) =>
    q.eq("normalized_condition", "graded").ilike("variant_ref", `%${target.slug}%`),
  );
  const { data: vmRows } = await supabase
    .from("public_variant_metrics")
    .select("provider, grade, provider_as_of_ts, history_points_30d")
    .eq("canonical_slug", target.slug);
  return {
    found: true,
    slug: target.slug,
    name: target.canonical_name,
    obsGradedRows: obsGraded,
    publicVariantMetrics: vmRows ?? [],
  };
}

function fmtPct(part, whole) {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

function renderReport(d) {
  const { layer1: l1, layer2: l2, layer3a: l3a, layer3b: l3b, layer4: l4, layer5: l5, layer6: l6, spotCheck: sc, generatedAt } = d;

  const headlineRatio = l1.distinctProviderCards
    ? `${((l3b.distinctSlugsGradedPublicView / l1.distinctProviderCards) * 100).toFixed(1)}%`
    : "—";

  const providerBucketRows = PROVIDERS.map((p) => {
    const cells = GRADED_BUCKETS.map((g) => fmtNum(l3b.gradedByProviderBucket[p]?.[g] ?? 0));
    return `| **${p}** | ${cells.join(" | ")} |`;
  }).join("\n");

  const sampleRows = l6.sample.length === 0
    ? "_No graded holdings found in the sample._"
    : l6.sample.map((h) => {
        const rawStr = h.rawMarketPrice == null ? "—" : `$${Number(h.rawMarketPrice).toFixed(2)}`;
        const gradedStr = h.gradedMarketPrice == null ? "—" : `$${Number(h.gradedMarketPrice).toFixed(2)}`;
        const delta = h.rawMarketPrice != null && h.gradedMarketPrice != null
          ? `$${(Number(h.gradedMarketPrice) - Number(h.rawMarketPrice)).toFixed(2)}`
          : "—";
        return `| \`${h.slug}\` | ${h.grade} | ${h.qty} | ${rawStr} | ${gradedStr} | ${delta} | ${h.gradedProvider ?? "—"} |`;
      }).join("\n");

  return `# Graded Pricing Coverage Report
_Generated ${generatedAt}. Run via \`node --env-file=.env.local scripts/report-graded-pricing-coverage.mjs\`. Auto-generated; **for narrative findings + interpretation see [graded-surfacing-plan.md](graded-surfacing-plan.md) Phase 0**. This file is pure data._

## Headline

| Metric | Value |
|---|---:|
| Graded observations ingested (\`provider_normalized_observations\`) | ${fmtNum(l1.gradedTotal)} |
| Distinct provider-side cards with graded entries (50k sample, lower bound) | ${fmtNum(l1.distinctProviderCards)} |
| Distinct canonical cards with graded data in \`card_metrics\` | ${fmtNum(l3a.distinctSlugsGraded)} |
| Distinct canonical cards with graded data in \`variant_metrics\` | ${fmtNum(l3b.distinctSlugsGradedVariantMetrics)} |
| Distinct canonical cards visible to users via \`public_variant_metrics\` | ${fmtNum(l3b.distinctSlugsGradedPublicView)} |
| Graded variant rows with \`history_points_30d > 0\` (integer count) | ${fmtNum(l3b.gradedWithPoints)} of ${fmtNum(l3b.gradedTotal)} |
| Graded variant rows with non-null \`signal_trend\` (signals require ≥10 pts) | **${fmtNum(l3b.gradedWithSignal)}** of ${fmtNum(l3b.gradedTotal)} |
| Graded variant rows with \`provider_as_of_ts\` in last 30d | ${fmtNum(l3b.gradedFresh30d)} of ${fmtNum(l3b.gradedTotal)} |
| Latest graded \`provider_as_of_ts\` (staleness signal) | ${l3b.latestGradedProviderAsOfTs ?? "—"}${l3b.latestGradedStalenessHours != null ? ` (${l3b.latestGradedStalenessHours}h ago)` : ""} |
| \`card_metrics → variant_metrics\` graded slug gap (intentional) | **${fmtNum(l3a.distinctSlugsGraded - l3b.distinctSlugsGradedVariantMetrics)}** slugs |

## Layer-by-layer

| Layer | Graded rows | RAW rows | Graded share |
|---|---:|---:|---:|
| 1. Observations (\`provider_normalized_observations\`, est. total ~${fmtNum(l1.gradedTotalAll)}) | ${fmtNum(l1.gradedTotal)} | ~${fmtNum(l1.gradedTotalAll - l1.gradedTotal)} | ${fmtPct(l1.gradedTotal, l1.gradedTotalAll)} |
| 2. Snapshots (\`price_snapshots\`) | ${fmtNum(l2.gradedTotal)} | ${fmtNum(l2.rawTotal)} | ${fmtPct(l2.gradedTotal, l2.gradedTotal + l2.rawTotal)} |
| 3a. Slug-level metrics (\`card_metrics\`) | ${fmtNum(l3a.gradedTotal)} | ${fmtNum(l3a.rawTotal)} | ${fmtPct(l3a.gradedTotal, l3a.gradedTotal + l3a.rawTotal)} |
| 3b. Variant metrics (\`variant_metrics\` — Grade Board source) | ${fmtNum(l3b.gradedTotal)} | ${fmtNum(l3b.rawTotal)} | ${fmtPct(l3b.gradedTotal, l3b.gradedTotal + l3b.rawTotal)} |

Most recent graded snapshot \`observed_at\`: ${l2.mostRecentGraded ?? "—"}.

## Snapshot rows by grade bucket

| ${GRADE_BUCKETS.join(" | ")} |
|${GRADE_BUCKETS.map(() => "---:").join("|")}|
| ${GRADE_BUCKETS.map((g) => fmtNum(l2.byGrade[g] || 0)).join(" | ")} |

## card_metrics rows by grade bucket

| ${GRADE_BUCKETS.join(" | ")} |
|${GRADE_BUCKETS.map(() => "---:").join("|")}|
| ${GRADE_BUCKETS.map((g) => fmtNum(l3a.byGrade[g] || 0)).join(" | ")} |

## variant_metrics: provider × bucket (graded only)

| Provider | ${GRADED_BUCKETS.join(" | ")} |
|---|${GRADED_BUCKETS.map(() => "---:").join("|")}|
${providerBucketRows}

## Observation provenance by grading provider

| Provider | Graded observations |
|---|---:|
${PROVIDERS.map((p) => `| ${p} | ${fmtNum(l1.gradedByProvider[p] || 0)} |`).join("\n")}

## Drop-off

The meaningful drop-off is between \`card_metrics\` (slug-level rollup) and \`variant_metrics\` (variant-level, what the Grade Board reads):

- Distinct canonical slugs with graded data in \`card_metrics\`: **${fmtNum(l3a.distinctSlugsGraded)}**
- Distinct canonical slugs with graded data in \`variant_metrics\`: **${fmtNum(l3b.distinctSlugsGradedVariantMetrics)}**
- Slugs with graded \`card_metrics\` rows that **never reach** \`variant_metrics\`: **${fmtNum(l3a.distinctSlugsGraded - l3b.distinctSlugsGradedVariantMetrics)}** (intentional — \`provider-observation-variant-metrics.ts\` hard-rejects graded; the existing variant_metrics graded rows are stale from a one-time 2026-04-15 batch)

(The \`price_snapshots\` 50k-row sample is biased toward the freshest 45% of graded snapshots and is **not** comparable to the full \`variant_metrics\` slug set; reported below for reference only.)

- Distinct canonical slugs in the price_snapshots 50k sample: ${fmtNum(l5.slugsAtSnapshot)} (sample, lower bound)
- Distinct canonical slugs in \`public_variant_metrics\`: ${fmtNum(l5.slugsAtPublicView)}

## PSA cert pipeline (separate from Scrydex)

| Metric | Value |
|---|---:|
| \`psa_certificates\` rows (estimated) | ${fmtNum(l4.psaCertCount)} |
| \`variant_metrics\` rows with \`provider='PSA'\` | ${fmtNum(l4.vmPsaTotal)} |

The PSA cert path is dual-gated: (1) PSA grade string must parse via \`gradeBucketFromPsaGrade\` ([app/api/ingest/psa/route.ts:52](../app/api/ingest/psa/route.ts)) and (2) the cert must resolve to a canonical \`(slug, printing_id)\` via \`resolvePsaPrinting\`. Certs that fail either gate stay in \`psa_certificates.raw_payload\` and never reach \`variant_metrics\`. Implied gate-survival rate: **${l4.psaCertCount ? fmtPct(l4.vmPsaTotal, l4.psaCertCount) : "—"}** (note: a single canonical printing can absorb many certs, so this is a lower bound on PSA's contribution rather than a literal cert→variant ratio).

## Holdings mis-valuation (concrete user impact)

| Metric | Value |
|---|---:|
| User holdings with graded grade | ${fmtNum(l6.gradedHoldings)} |
| User holdings with RAW grade (NM/LP/MP/HP/DMG/RAW) | ${fmtNum(l6.rawHoldings)} |
| User holdings with NULL grade | ${fmtNum(l6.nullGradeHoldings)} |

[\`/api/holdings/summary\`](../app/api/holdings/summary/route.ts) hard-codes \`eq("grade", "RAW")\` at lines 97 and 106, so every graded holding above is **valued at the RAW market price** in the iOS portfolio. Sample of up to 10 distinct (slug, grade) graded holdings:

| Slug | Holding grade | Qty | RAW market (what user sees) | Graded market (what they should see) | Δ | Provider |
|---|---|---:|---:|---:|---:|---|
${sampleRows}

## Surfacing matrix

| Surface | File:line | Renders graded? | Notes |
|---|---|---|---|
| Web Grade Board (card detail page) | [app/c/\\[slug\\]/page.tsx:1143](../app/c/[slug]/page.tsx) | ✓ chart + tiles | Reads \`public_variant_metrics\` + \`public_price_history\` directly via PostgREST; provider toggle (PSA/BGS/CGC) + grade picker render with real prices. Reference price (\`selectedGradedReference\`) comes from \`gradeSnapMap[grade].median_7d\`; provider tiles come from latest \`public_price_history\` row per variant_ref |
| iOS Grade Board | [ios/PopAlphaApp/CardDetailView.swift:67](../ios/PopAlphaApp/CardDetailView.swift) | ✓ chart + tiles | Calls \`fetchGradedVariantMetrics\` ([CardService.swift:169](../ios/PopAlphaApp/CardService.swift)) for variant list, \`fetchGradedPriceHistory\` ([CardService.swift:149](../ios/PopAlphaApp/CardService.swift)) for the chart (variant_ref ilike pattern). \`history_points_30d\` (integer) is used as a sufficiency gate, not chart data |
| \`/api/market/snapshot\` | [route.ts:60,95](../app/api/market/snapshot/route.ts) | partial | Accepts \`?grade=\` and returns metric \`market_price\`; price-history confidence band only fires when \`grade='RAW'\` |
| \`/api/pro/signals\` | [route.ts:60](../app/api/pro/signals/route.ts) | ✗ | Hard-coded \`eq("grade", "RAW")\` — pro users see no graded signals |
| \`/api/holdings/summary\` | [route.ts:97,106](../app/api/holdings/summary/route.ts) | ✗ | Hard-coded \`eq("grade", "RAW")\` for both market_price and hot-mover lookup; graded holdings mis-valued |
| \`/api/portfolio/overview\` | [route.ts:190-212](../app/api/portfolio/overview/route.ts) | counts only | Counts graded vs raw holdings; \`totalValue\` derives from \`marketPulseMap\` which is RAW-only by construction |
| \`/api/personalization/explanation\` | [route.ts:120](../app/api/personalization/explanation/route.ts) | flag only | Adds \`is_graded\` boolean for explanation copy |
| Daily top movers rail | [compute-daily-top-movers/route.ts](../app/api/cron/compute-daily-top-movers/route.ts) | ✗ | RPC \`compute_daily_top_movers\` has no \`grade\` parameter — RAW-only by construction |
| Market signals | [market-signals/route.ts](../app/api/market-signals/route.ts) | ✗ | No grade dimension |
| Analytics variant_metrics writer | commit \`33cc91b\` | ✗ | Skips graded observations entirely |
| RAW price history view | commit \`cbefdec\` | ✗ | Excludes \`GRADED::\` variant_refs |

## Spot-check

${sc.found
  ? `Looked up \`${sc.slug}\` (${sc.name ?? "—"}). \`public_variant_metrics\` rows: **${fmtNum(sc.publicVariantMetrics.length)}**${
      sc.publicVariantMetrics.length > 0
        ? ` (providers: ${[...new Set(sc.publicVariantMetrics.map((r) => r.provider))].join(", ")}; grades: ${[...new Set(sc.publicVariantMetrics.map((r) => r.grade))].join(", ")})`
        : ""
    }.`
  : "_Tropical Beach BW28 not found via slug ilike — skipping spot-check._"}

---

For narrative interpretation, open questions, and methodology caveats, see [graded-surfacing-plan.md](graded-surfacing-plan.md) Phase 0. For at-a-glance live coverage numbers without running this 7-min script, use \`GET /api/debug/graded-coverage\` (cron-secret authed, runs in ~2s).
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
