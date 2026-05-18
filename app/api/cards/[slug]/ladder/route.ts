import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Unified card-ladder endpoint. Returns the full grade ladder for one
 * canonical slug as a single structured payload that's both UI-friendly
 * and LLM-readable.
 *
 * Why this exists: graded coverage was added piecemeal across
 * /api/pro/signals (PR #102), /api/market/snapshot (PR #105), and
 * /api/portfolio/overview (PR #106). Each surfaces a slice. Card ladder
 * UX and LLM "compare this card across grades" prompts both want the
 * whole ladder at once with explicit confidence + sample sizes per row.
 * Stitching three internal calls together client-side loses the joins.
 *
 * Data sources (all anon-grantable; no service-role needed):
 *   - canonical_cards               → name, set, year, language
 *   - public_card_metrics           → per-(slug, printing_id, grade) rollup,
 *                                     fallback chain for graded headline price
 *   - public_variant_metrics        → per-(slug, variant_ref, provider, grade)
 *                                     trend + activity (no median, no signals)
 *
 * Signal columns (signal_trend / signal_breakout / signal_value) stay in
 * pro_variant_metrics — that's the Pro paywall boundary established by
 * supabase/migrations/20260303230000_signal_paywall_views.sql. Use
 * /api/pro/signals for those.
 *
 * Per-grader median spread (PSA10 = $X vs CGC10 = $Y) is intentionally
 * NOT in this v1: variant_metrics has trend slope + history points per
 * (provider, grade) but no median price column. Surfacing per-grader
 * medians needs a separate aggregation pass over price_snapshots, which
 * the metrics writer doesn't currently produce. v2 candidate; flagged
 * via summary.data_quality_note so the LLM doesn't claim per-grader
 * spread is missing because the card lacks data.
 *
 * Cross-language note: jp_source surfaces JP-NATIVE prices for the
 * SAME canonical_slug (e.g. an EN card's slug joined to Yahoo/Snkrdunk
 * via canonical_slug). The EN↔JP equivalence linkage (an EN slug's JP
 * counterpart slug) is owned by the card_translations table and is
 * being expanded by a parallel workstream — that linkage is not yet
 * flowed through this endpoint.
 *
 * Usage: GET /api/cards/<slug>/ladder
 */

// Mirrors GRADE_BUCKETS in lib/cards/detail-types.ts. Listed in
// "low → high" order so iteration produces a natural ladder.
const GRADE_ORDER = ["RAW", "LE_7", "G8", "G9", "G9_5", "G10", "G10_PERFECT"] as const;
type GradeKey = (typeof GRADE_ORDER)[number];

// Graders we attribute per-(provider, grade) rows under. Mirrors
// GRADED_PROVIDERS in lib/cards/detail-types.ts.
const GRADED_PROVIDERS = ["PSA", "TAG", "BGS", "CGC"] as const;

type CanonicalRow = {
  slug: string;
  canonical_name: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
};

type MetricsRow = {
  printing_id: string | null;
  grade: string | null;
  market_price: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  market_price_as_of: string | null;
  market_confidence_score: number | null;
  snapshot_count_30d: number | null;
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  yahoo_jp_price: number | null;
  yahoo_jp_price_jpy: number | null;
  yahoo_jp_sample_count: number | null;
  yahoo_jp_observed_at: string | null;
  snkrdunk_price: number | null;
  snkrdunk_price_jpy: number | null;
  snkrdunk_sample_count: number | null;
  snkrdunk_observed_at: string | null;
  updated_at: string | null;
};

type VariantRow = {
  variant_ref: string | null;
  provider: string | null;
  grade: string | null;
  history_points_30d: number | null;
  provider_trend_slope_7d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
  provider_as_of_ts: string | null;
};

type GraderBreakdown = {
  provider: string;
  history_points_30d: number | null;
  provider_trend_slope_7d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
  provider_as_of_ts: string | null;
};

type GradeRung = {
  grade: GradeKey;
  available: boolean;
  // Walked fallback chain: market_price → median_7d → median_30d → trimmed_median_30d.
  // null only when ALL four are null. headline_price_source tells the
  // caller which level of the chain produced the number.
  headline_price_usd: number | null;
  headline_price_source:
    | "market_price"
    | "median_7d"
    | "median_30d"
    | "trimmed_median_30d"
    | null;
  median_7d_usd: number | null;
  median_30d_usd: number | null;
  trimmed_median_30d_usd: number | null;
  low_30d_usd: number | null;
  high_30d_usd: number | null;
  snapshot_count_30d: number | null;
  confidence_score: number | null;
  as_of: string | null;
  // RAW-only on the card_metrics writer today; null on graded rows.
  change_pct_24h: number | null;
  change_pct_7d: number | null;
  // Premium vs RAW headline. 1.0 on RAW. null when either side missing.
  premium_vs_raw: number | null;
  // Per-grader (PSA / CGC / BGS / TAG) activity rows from
  // public_variant_metrics. No medians (see route docstring). Only
  // populated for graded grades; empty array on RAW.
  graders: GraderBreakdown[];
};

type LadderResponse = {
  ok: true;
  slug: string;
  canonical: {
    name: string | null;
    set_name: string | null;
    card_number: string | null;
    year: number | null;
    language: string | null;
  };
  as_of: string | null;
  grades: GradeRung[];
  jp_source: {
    snkrdunk_price_usd: number | null;
    snkrdunk_price_jpy: number | null;
    snkrdunk_sample_count: number | null;
    snkrdunk_observed_at: string | null;
    yahoo_jp_price_usd: number | null;
    yahoo_jp_price_jpy: number | null;
    yahoo_jp_sample_count: number | null;
    yahoo_jp_observed_at: string | null;
    note: string;
  };
  summary: {
    raw_headline_usd: number | null;
    max_premium: { grade: GradeKey; ratio: number } | null;
    graded_grades_with_price: GradeKey[];
    data_quality_note: string;
  };
};

function isGradeKey(value: string | null | undefined): value is GradeKey {
  return value != null && (GRADE_ORDER as readonly string[]).includes(value);
}

// Walks the fallback chain. PR #106 established this pattern for
// portfolio valuation; reused here so the ladder rung matches portfolio
// row valuation exactly for the same (slug, grade).
function resolveHeadline(row: MetricsRow): {
  price: number | null;
  source: GradeRung["headline_price_source"];
} {
  if (row.market_price != null) return { price: row.market_price, source: "market_price" };
  if (row.median_7d != null) return { price: row.median_7d, source: "median_7d" };
  if (row.median_30d != null) return { price: row.median_30d, source: "median_30d" };
  if (row.trimmed_median_30d != null) {
    return { price: row.trimmed_median_30d, source: "trimmed_median_30d" };
  }
  return { price: null, source: null };
}

// Picks the row for a given grade. card_metrics has one row per
// (slug, printing_id, grade) — when multiple printings exist we pick
// the row with the highest snapshot_count_30d (= most reliable) so the
// ladder rung reflects the most-traded printing for that grade.
function pickGradeRow(rows: MetricsRow[], grade: GradeKey): MetricsRow | null {
  const candidates = rows.filter((r) => r.grade === grade);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((best, current) => {
    const bestCount = best.snapshot_count_30d ?? -1;
    const currentCount = current.snapshot_count_30d ?? -1;
    return currentCount > bestCount ? current : best;
  });
}

function pickJpSource(rows: MetricsRow[]): MetricsRow | null {
  // JP columns are joined onto every grade row but the per-grade row
  // they appear on isn't meaningful — the join keys to (slug, printing,
  // grade). RAW is the most common surface and will usually have
  // non-null JP fields; fall back to any row that has a JP value.
  const raw = pickGradeRow(rows, "RAW");
  const hasJp = (r: MetricsRow | null) =>
    r != null && (r.snkrdunk_price != null || r.yahoo_jp_price != null);
  if (hasJp(raw)) return raw;
  return rows.find(hasJp) ?? raw ?? rows[0] ?? null;
}

function groupGraders(rows: VariantRow[], grade: GradeKey): GraderBreakdown[] {
  if (grade === "RAW") return [];
  return rows
    .filter(
      (r) =>
        r.grade === grade &&
        r.provider != null &&
        (GRADED_PROVIDERS as readonly string[]).includes(r.provider),
    )
    .reduce<GraderBreakdown[]>((acc, r) => {
      // De-dupe by provider, keeping the row with the most history
      // points (variant_metrics is per (variant_ref, provider, grade)
      // and a single slug+grade can have multiple variant_refs in
      // theory; pick the most-active one to represent the grader).
      const existingIdx = acc.findIndex((g) => g.provider === r.provider);
      const candidate: GraderBreakdown = {
        provider: r.provider as string,
        history_points_30d: r.history_points_30d,
        provider_trend_slope_7d: r.provider_trend_slope_7d,
        provider_price_relative_to_30d_range: r.provider_price_relative_to_30d_range,
        provider_price_changes_count_30d: r.provider_price_changes_count_30d,
        provider_as_of_ts: r.provider_as_of_ts,
      };
      if (existingIdx === -1) {
        acc.push(candidate);
      } else {
        const existing = acc[existingIdx];
        const existingPts = existing.history_points_30d ?? -1;
        const candidatePts = candidate.history_points_30d ?? -1;
        if (candidatePts > existingPts) acc[existingIdx] = candidate;
      }
      return acc;
    }, [])
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug: rawSlug } = await context.params;
  const slug = typeof rawSlug === "string" ? rawSlug.trim() : "";
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "Missing card slug." },
      { status: 400 },
    );
  }

  const supabase = dbPublic();

  const [canonicalResult, metricsResult, variantResult] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number, language")
      .eq("slug", slug)
      .maybeSingle<CanonicalRow>(),
    supabase
      .from("public_card_metrics")
      .select(
        [
          "printing_id",
          "grade",
          "market_price",
          "median_7d",
          "median_30d",
          "trimmed_median_30d",
          "low_30d",
          "high_30d",
          "market_price_as_of",
          "market_confidence_score",
          "snapshot_count_30d",
          "change_pct_24h",
          "change_pct_7d",
          "yahoo_jp_price",
          "yahoo_jp_price_jpy",
          "yahoo_jp_sample_count",
          "yahoo_jp_observed_at",
          "snkrdunk_price",
          "snkrdunk_price_jpy",
          "snkrdunk_sample_count",
          "snkrdunk_observed_at",
          "updated_at",
        ].join(", "),
      )
      .eq("canonical_slug", slug)
      .in("grade", [...GRADE_ORDER]),
    supabase
      .from("public_variant_metrics")
      .select(
        [
          "variant_ref",
          "provider",
          "grade",
          "history_points_30d",
          "provider_trend_slope_7d",
          "provider_price_relative_to_30d_range",
          "provider_price_changes_count_30d",
          "provider_as_of_ts",
        ].join(", "),
      )
      .eq("canonical_slug", slug)
      .in("provider", [...GRADED_PROVIDERS])
      .in("grade", [...GRADE_ORDER]),
  ]);

  if (canonicalResult.error) {
    console.error("[cards/ladder] canonical_cards", slug, canonicalResult.error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
  if (metricsResult.error) {
    console.error("[cards/ladder] public_card_metrics", slug, metricsResult.error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
  if (variantResult.error) {
    console.error("[cards/ladder] public_variant_metrics", slug, variantResult.error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  if (!canonicalResult.data) {
    return NextResponse.json({ ok: false, error: "Card not found." }, { status: 404 });
  }

  const canonical = canonicalResult.data;
  // Cast through `unknown` because supabase-js infers a stricter
  // GenericStringError union for joined `select()` strings.
  const metricRows = (metricsResult.data ?? []) as unknown as MetricsRow[];
  const variantRows = (variantResult.data ?? []) as unknown as VariantRow[];

  // Pre-resolve RAW headline so we can compute premiums in one pass.
  const rawRow = pickGradeRow(metricRows, "RAW");
  const rawHeadline = rawRow ? resolveHeadline(rawRow).price : null;

  const grades: GradeRung[] = GRADE_ORDER.map((grade) => {
    const row = pickGradeRow(metricRows, grade);
    if (!row) {
      return {
        grade,
        available: false,
        headline_price_usd: null,
        headline_price_source: null,
        median_7d_usd: null,
        median_30d_usd: null,
        trimmed_median_30d_usd: null,
        low_30d_usd: null,
        high_30d_usd: null,
        snapshot_count_30d: null,
        confidence_score: null,
        as_of: null,
        change_pct_24h: null,
        change_pct_7d: null,
        premium_vs_raw: null,
        graders: groupGraders(variantRows, grade),
      };
    }

    const { price: headline, source } = resolveHeadline(row);
    const premium =
      headline != null && rawHeadline != null && rawHeadline > 0
        ? Number((headline / rawHeadline).toFixed(3))
        : grade === "RAW" && headline != null
          ? 1.0
          : null;

    return {
      grade,
      available: headline != null,
      headline_price_usd: headline,
      headline_price_source: source,
      median_7d_usd: row.median_7d,
      median_30d_usd: row.median_30d,
      trimmed_median_30d_usd: row.trimmed_median_30d,
      low_30d_usd: row.low_30d,
      high_30d_usd: row.high_30d,
      snapshot_count_30d: row.snapshot_count_30d,
      confidence_score: row.market_confidence_score,
      as_of: row.market_price_as_of ?? row.updated_at,
      // Only meaningful on RAW today (card_metrics writer doesn't emit
      // these for graded rollups). Surfacing as null on graded rather
      // than fabricating zero so the LLM can reason about availability.
      change_pct_24h: grade === "RAW" ? row.change_pct_24h : null,
      change_pct_7d: grade === "RAW" ? row.change_pct_7d : null,
      premium_vs_raw: premium,
      graders: groupGraders(variantRows, grade),
    };
  });

  const jpRow = pickJpSource(metricRows);
  const jpSource: LadderResponse["jp_source"] = {
    snkrdunk_price_usd: jpRow?.snkrdunk_price ?? null,
    snkrdunk_price_jpy: jpRow?.snkrdunk_price_jpy ?? null,
    snkrdunk_sample_count: jpRow?.snkrdunk_sample_count ?? null,
    snkrdunk_observed_at: jpRow?.snkrdunk_observed_at ?? null,
    yahoo_jp_price_usd: jpRow?.yahoo_jp_price ?? null,
    yahoo_jp_price_jpy: jpRow?.yahoo_jp_price_jpy ?? null,
    yahoo_jp_sample_count: jpRow?.yahoo_jp_sample_count ?? null,
    yahoo_jp_observed_at: jpRow?.yahoo_jp_observed_at ?? null,
    note:
      "JP-source prices keyed to THIS slug (canonical_slug join). EN↔JP " +
      "equivalence (the JP printing of an EN card) is in card_translations, " +
      "not yet flowed through this endpoint.",
  };

  // max_premium ranks across graded grades with a price. Skips RAW
  // (ratio always 1.0) and grades with no headline.
  const maxPremium = grades
    .filter((g) => g.grade !== "RAW" && g.premium_vs_raw != null)
    .reduce<{ grade: GradeKey; ratio: number } | null>((best, g) => {
      const ratio = g.premium_vs_raw as number;
      if (best == null || ratio > best.ratio) return { grade: g.grade, ratio };
      return best;
    }, null);

  const gradedAvailable = grades
    .filter((g) => g.grade !== "RAW" && g.headline_price_usd != null)
    .map((g) => g.grade);

  const dataQualityNote =
    "Per-grade headline walks the fallback chain " +
    "market_price → median_7d → median_30d → trimmed_median_30d. " +
    "Graded headline is the cross-grader aggregate from card_metrics; " +
    "per-grader median spread (PSA10 vs CGC10) is not in v1 of this " +
    "endpoint — variant_metrics has per-grader trend + activity but no " +
    "per-grader median price column. Direction signals (signal_trend, " +
    "signal_breakout, signal_value) are paywalled and live in /api/pro/signals.";

  // Latest as_of across the rungs is the response-level freshness anchor.
  const asOf = grades.reduce<string | null>((latest, g) => {
    if (!g.as_of) return latest;
    if (!latest) return g.as_of;
    return new Date(g.as_of).getTime() > new Date(latest).getTime() ? g.as_of : latest;
  }, null);

  const payload: LadderResponse = {
    ok: true,
    slug: canonical.slug,
    canonical: {
      name: canonical.canonical_name,
      set_name: canonical.set_name,
      card_number: canonical.card_number,
      year: canonical.year,
      language: canonical.language,
    },
    as_of: asOf,
    grades,
    jp_source: jpSource,
    summary: {
      raw_headline_usd: rawHeadline,
      max_premium: maxPremium,
      graded_grades_with_price: gradedAvailable,
      data_quality_note: dataQualityNote,
    },
  };

  return NextResponse.json(payload);
}
