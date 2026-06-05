import { NextResponse } from "next/server";
import { loadJpPriceCoverageMap } from "@/lib/data/jp-price-coverage";
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
 *   - public_graded_variant_prices  → per-(slug, printing_id, grade, grader)
 *                                     price: latest + 14d/7d/30d median + 30D
 *                                     range + sample count (the PSA10≠CGC10 split)
 *
 * Signal columns (signal_trend / signal_breakout / signal_value) stay in
 * pro_variant_metrics — that's the Pro paywall boundary established by
 * supabase/migrations/20260303230000_signal_paywall_views.sql. Use
 * /api/pro/signals for those.
 *
 * Per-grader price spread (PSA10 = $X vs CGC10 = $Y) IS surfaced now, from
 * public_graded_variant_prices (the grader-split landed in #189/#190). Each
 * graders[] rung carries that grader's own latest price + 14d/7d/30d median +
 * 30D range + sample count, taken from the most-traded printing of the slug.
 * variant_metrics still supplies per-grader trend + activity; the two are
 * merged in groupGraders().
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

type GradedPriceRow = {
  printing_id: string | null;
  grade: string | null;
  grader: string | null;
  latest_price: number | null;
  latest_price_as_of: string | null;
  market_price: number | null;
  market_price_as_of: string | null;
  median_7d: number | null;
  median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  snapshot_count_30d: number | null;
};

type GraderBreakdown = {
  provider: string;
  // Activity (public_variant_metrics): most-ACTIVE printing for this grader+grade.
  history_points_30d: number | null;
  provider_trend_slope_7d: number | null;
  provider_price_relative_to_30d_range: number | null;
  provider_price_changes_count_30d: number | null;
  provider_as_of_ts: string | null;
  // Price (public_graded_variant_prices): the most-TRADED printing for this
  // grader+grade. printing_id labels WHICH printing — for multi-printing cards
  // different graders can resolve to different printings, so compare with that in
  // mind. market_price_usd = 14-day median (the headline). This is what makes
  // PSA 10 vs CGC 10 a real per-grader number instead of a pooled average.
  printing_id: string | null;
  latest_price_usd: number | null;
  market_price_usd: number | null;
  median_7d_usd: number | null;
  median_30d_usd: number | null;
  low_30d_usd: number | null;
  high_30d_usd: number | null;
  price_snapshot_count_30d: number | null;
  price_as_of: string | null;
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
  // Per-grader (PSA / CGC / BGS / TAG) rungs: price (public_graded_variant_prices)
  // + activity (public_variant_metrics), merged in groupGraders(). Only
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

// Picks the canonical (printing_id IS NULL) row for a given grade.
// card_metrics writes both per-printing rows AND a canonical aggregate
// row per (slug, grade) — the canonical row is what /api/market/snapshot
// and /api/portfolio/overview both query for the slug-level rollup. We
// query with `.is("printing_id", null)` so this filter is normally a
// no-op (each grade has exactly one canonical row), but we keep the
// .filter() guard so a stray per-printing row never leaks into a
// ladder rung — that would cause headline_price_usd / premium_vs_raw
// to mix printings (e.g. RAW from printing A vs G10 from printing B).
function pickGradeRow(rows: MetricsRow[], grade: GradeKey): MetricsRow | null {
  return rows.find((r) => r.grade === grade && r.printing_id == null) ?? null;
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

function groupGraders(
  variantRows: VariantRow[],
  gradedPriceRows: GradedPriceRow[],
  grade: GradeKey,
): GraderBreakdown[] {
  if (grade === "RAW") return [];

  // Per-grader PRICE: the most-traded printing (highest snapshot_count_30d)
  // for this grader+grade. Slug-level framing — same as the activity rail,
  // this answers "what does THIS grader's <grade> of <slug> trade at",
  // collapsing to the dominant printing when a slug has several.
  const priceByGrader = new Map<string, GradedPriceRow>();
  for (const p of gradedPriceRows) {
    if (p.grade !== grade || p.grader == null) continue;
    if (!(GRADED_PROVIDERS as readonly string[]).includes(p.grader)) continue;
    const existing = priceByGrader.get(p.grader);
    if (!existing || (p.snapshot_count_30d ?? -1) > (existing.snapshot_count_30d ?? -1)) {
      priceByGrader.set(p.grader, p);
    }
  }

  // Per-grader ACTIVITY: the most-active printing (highest history_points_30d).
  const activityByGrader = new Map<string, VariantRow>();
  for (const r of variantRows) {
    if (r.grade !== grade || r.provider == null) continue;
    if (!(GRADED_PROVIDERS as readonly string[]).includes(r.provider)) continue;
    const existing = activityByGrader.get(r.provider);
    if (!existing || (r.history_points_30d ?? -1) > (existing.history_points_30d ?? -1)) {
      activityByGrader.set(r.provider, r);
    }
  }

  // A grader appears if it has EITHER a price or an activity row.
  const providers = new Set<string>([...priceByGrader.keys(), ...activityByGrader.keys()]);
  return [...providers]
    .map((provider): GraderBreakdown => {
      const a = activityByGrader.get(provider);
      const p = priceByGrader.get(provider);
      return {
        provider,
        history_points_30d: a?.history_points_30d ?? null,
        provider_trend_slope_7d: a?.provider_trend_slope_7d ?? null,
        provider_price_relative_to_30d_range: a?.provider_price_relative_to_30d_range ?? null,
        provider_price_changes_count_30d: a?.provider_price_changes_count_30d ?? null,
        provider_as_of_ts: a?.provider_as_of_ts ?? null,
        printing_id: p?.printing_id ?? null,
        latest_price_usd: p?.latest_price ?? null,
        market_price_usd: p?.market_price ?? null,
        median_7d_usd: p?.median_7d ?? null,
        median_30d_usd: p?.median_30d ?? null,
        low_30d_usd: p?.low_30d ?? null,
        high_30d_usd: p?.high_30d ?? null,
        price_snapshot_count_30d: p?.snapshot_count_30d ?? null,
        price_as_of: p?.market_price_as_of ?? p?.latest_price_as_of ?? null,
      };
    })
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

  const [canonicalResult, metricsResult, variantResult, gradedPriceResult, jpCoverageResult] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number, language")
      .eq("slug", slug)
      .maybeSingle<CanonicalRow>(),
    // canonical rollup rows only (printing_id IS NULL). Matches the
    // slug-level query in /api/market/snapshot and the canonical valuation
    // path in /api/portfolio/overview so ladder rungs are consistent.
    // Without this, multi-printing slugs would mix headlines from
    // different printings across grades (RAW from printing A vs G10
    // from printing B), corrupting premium_vs_raw.
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
      .is("printing_id", null)
      .in("grade", [...GRADE_ORDER]),
    // Asymmetry vs the card_metrics query above: variant_metrics is
    // written per-printing only (no canonical rollup row — see
    // lib/backfill/provider-observation-variant-metrics.ts line ~616).
    // We deliberately DON'T filter `.is("printing_id", null)` here or
    // the per-grader rail would always be empty. groupGraders() dedupes
    // by provider across printings so the rung surfaces "is anyone
    // trading PSA10 of <slug>" rather than tying to one printing.
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
    // Per-grader PRICE (PR-B). public_graded_variant_prices is keyed
    // (canonical_slug, printing_id, grade, grader) — the per-(printing,
    // grader, grade) split landed in #189/#190. groupGraders() folds the
    // most-traded printing's price into each grader rung. RAW won't match.
    supabase
      .from("public_graded_variant_prices")
      .select(
        [
          "printing_id",
          "grade",
          "grader",
          "latest_price",
          "latest_price_as_of",
          "market_price",
          "market_price_as_of",
          "median_7d",
          "median_30d",
          "low_30d",
          "high_30d",
          "snapshot_count_30d",
        ].join(", "),
      )
      .eq("canonical_slug", slug)
      .in("grade", [...GRADE_ORDER]),
    loadJpPriceCoverageMap(supabase, [slug])
      .then((data) => ({ data, error: null as Error | null }))
      .catch((error: unknown) => ({
        data: new Map(),
        error: error instanceof Error ? error : new Error(String(error)),
      })),
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
  if (gradedPriceResult.error) {
    console.error("[cards/ladder] public_graded_variant_prices", slug, gradedPriceResult.error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }
  if (jpCoverageResult.error) {
    console.error("[cards/ladder] public_jp_price_coverage", slug, jpCoverageResult.error.message);
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
  const gradedPriceRows = (gradedPriceResult.data ?? []) as unknown as GradedPriceRow[];

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
        graders: groupGraders(variantRows, gradedPriceRows, grade),
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
      graders: groupGraders(variantRows, gradedPriceRows, grade),
    };
  });

  const jpCoverage = jpCoverageResult.data.get(slug) ?? null;
  const jpRow = jpCoverage ? null : pickJpSource(metricRows);
  const jpSource: LadderResponse["jp_source"] = {
    snkrdunk_price_usd: jpCoverage?.snkrdunkPriceUsd ?? jpRow?.snkrdunk_price ?? null,
    snkrdunk_price_jpy: jpCoverage?.snkrdunkPriceJpy ?? jpRow?.snkrdunk_price_jpy ?? null,
    snkrdunk_sample_count: jpCoverage?.snkrdunkSampleCount ?? jpRow?.snkrdunk_sample_count ?? null,
    snkrdunk_observed_at: jpCoverage?.snkrdunkObservedAt ?? jpRow?.snkrdunk_observed_at ?? null,
    yahoo_jp_price_usd: jpCoverage?.yahooJpPriceUsd ?? jpRow?.yahoo_jp_price ?? null,
    yahoo_jp_price_jpy: jpCoverage?.yahooJpPriceJpy ?? jpRow?.yahoo_jp_price_jpy ?? null,
    yahoo_jp_sample_count: jpCoverage?.yahooJpSampleCount ?? jpRow?.yahoo_jp_sample_count ?? null,
    yahoo_jp_observed_at: jpCoverage?.yahooJpObservedAt ?? jpRow?.yahoo_jp_observed_at ?? null,
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
    "The grade-rung headline is the cross-grader aggregate from card_metrics; " +
    "per-grader price spread (PSA10 vs CGC10) IS available in graders[] — each " +
    "carries that grader's own latest / 14d / 7d / 30d price + 30D range + sample " +
    "count from public_graded_variant_prices, taken from that grader's most-traded " +
    "printing (graders[].printing_id labels which; for multi-printing cards different " +
    "graders can resolve to different printings, so do not read a cross-grader gap as " +
    "a pure grade premium without checking printing_id). " +
    "Direction signals (signal_trend, signal_breakout, signal_value) are " +
    "paywalled and live in /api/pro/signals.";

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
