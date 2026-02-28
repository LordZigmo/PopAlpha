import { getServerSupabaseClient } from "@/lib/supabaseServer";
import {
  GRADED_PROVIDERS,
  GRADE_BUCKETS,
  type CardDetailMetrics,
  type CardDetailResponse,
  type CardPrintingPill,
  type GradeBucket,
  type GradedProvider,
} from "@/lib/cards/detail-types";

const RAW_AVAILABILITY_THRESHOLD = 5;
const GRADED_AVAILABILITY_THRESHOLD = 5;

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
};

type CardRow = {
  canonical_slug: string | null;
};

type CardPrintingRow = {
  id: string;
  canonical_slug: string;
  finish: string;
  finish_detail: string | null;
  edition: string;
  stamp: string | null;
  image_url: string | null;
};

type RawMetricRow = {
  printing_id: string | null;
  signal_trend_strength: number | null;
  signal_breakout: number | null;
  signal_value_zone: number | null;
  signals_as_of_ts: string | null;
  liquidity_score: number | null;
  snapshot_count_30d: number | null;
};

type GradedMetricRow = {
  printing_id: string | null;
  provider: string;
  grade: string;
  signal_trend: number | null;
  signal_breakout: number | null;
  signal_value: number | null;
  signals_as_of_ts: string | null;
  history_points_30d: number | null;
};

function toTitleLabel(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeLabelToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function finishPillLabel(finish: string): string {
  switch (finish) {
    case "HOLO":
      return "Holo";
    case "NON_HOLO":
      return "Non-Holo";
    case "REVERSE_HOLO":
      return "Reverse Holo";
    case "ALT_HOLO":
      return "Alt Holo";
    default:
      return "Unknown";
  }
}

function editionPillLabel(edition: string): string {
  if (edition === "FIRST_EDITION") return "1st Edition";
  if (edition === "UNLIMITED") return "Unlimited";
  return "Unknown Edition";
}

function stampPillLabel(stamp: string): string {
  if (stamp.toUpperCase() === "SHADOWLESS") return "Shadowless";
  return toTitleLabel(stamp);
}

export function buildPrintingPill(row: CardPrintingRow): CardPrintingPill {
  let pillLabel = finishPillLabel(row.finish);
  let kind = "finish";
  let token = normalizeLabelToken(row.finish);

  if (row.edition && row.edition !== "UNKNOWN") {
    pillLabel = editionPillLabel(row.edition);
    kind = "edition";
    token = normalizeLabelToken(row.edition);
  }

  if (row.stamp) {
    pillLabel = stampPillLabel(row.stamp);
    kind = "stamp";
    token = normalizeLabelToken(row.stamp);
  }

  return {
    printingId: row.id,
    pillKey: `${kind}:${token}:${row.id}`,
    pillLabel,
    finish: row.finish,
    edition: row.edition,
    stamp: row.stamp,
    imageUrl: row.image_url,
  };
}

function buildRawMetrics(row: RawMetricRow | null): CardDetailMetrics | null {
  if (!row) return null;
  return {
    trend: row.signal_trend_strength,
    breakout: row.signal_breakout,
    valueZone: row.signal_value_zone,
    asOf: row.signals_as_of_ts,
    liquidityScore: row.liquidity_score,
    points30d: row.snapshot_count_30d,
  };
}

function buildGradedMetrics(row: GradedMetricRow | null): CardDetailMetrics | null {
  if (!row) return null;
  return {
    trend: row.signal_trend,
    breakout: row.signal_breakout,
    valueZone: row.signal_value,
    asOf: row.signals_as_of_ts,
    liquidityScore: null,
    points30d: row.history_points_30d,
  };
}

export async function resolveCanonicalSlug(input: string): Promise<string | null> {
  const supabase = getServerSupabaseClient();
  const slug = input.trim();
  if (!slug) return null;

  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle<{ slug: string }>();
  if (canonical?.slug) return canonical.slug;

  const { data: card } = await supabase
    .from("cards")
    .select("canonical_slug")
    .eq("slug", slug)
    .maybeSingle<CardRow>();

  return card?.canonical_slug ?? null;
}

function pickBestPrintingId(
  rawVariants: CardDetailResponse["raw"]["variants"],
  gradedMatrix: CardDetailResponse["graded"]["matrix"],
  mode: "RAW" | "GRADED",
): string | null {
  if (mode === "GRADED") {
    const gradedByPrinting = new Map<string, number>();
    for (const row of gradedMatrix) {
      const score = row.metrics?.points30d ?? 0;
      const current = gradedByPrinting.get(row.printingId) ?? -1;
      if (score > current) gradedByPrinting.set(row.printingId, score);
    }
    const gradedWinner = [...gradedByPrinting.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (gradedWinner) return gradedWinner;
  }

  const rawWinner = [...rawVariants]
    .sort((a, b) => {
      const scoreDelta = (b.metrics?.liquidityScore ?? -1) - (a.metrics?.liquidityScore ?? -1);
      if (scoreDelta !== 0) return scoreDelta;
      return (b.metrics?.points30d ?? -1) - (a.metrics?.points30d ?? -1);
    })[0]?.printingId ?? null;

  return rawWinner ?? rawVariants[0]?.printingId ?? gradedMatrix[0]?.printingId ?? null;
}

function pickDefaultProvider(
  matrix: CardDetailResponse["graded"]["matrix"],
  printingId: string | null,
): GradedProvider | null {
  const rows = printingId ? matrix.filter((row) => row.printingId === printingId) : matrix;
  const availableProviders = [...new Set(rows.filter((row) => row.available).map((row) => row.provider))] as GradedProvider[];
  if (availableProviders.includes("PSA")) return "PSA";
  return availableProviders[0] ?? null;
}

function pickDefaultGradeBucket(
  matrix: CardDetailResponse["graded"]["matrix"],
  printingId: string | null,
  provider: GradedProvider | null,
): GradeBucket | null {
  const rows = matrix.filter((row) => {
    if (printingId && row.printingId !== printingId) return false;
    if (provider && row.provider !== provider) return false;
    return row.available;
  });
  const available = [...new Set(rows.map((row) => row.gradeBucket))] as GradeBucket[];
  if (available.includes("G9")) return "G9";
  if (available.includes("G10")) return "G10";
  return available[0] ?? null;
}

export async function buildCardDetailResponse(inputSlug: string): Promise<CardDetailResponse | null> {
  const supabase = getServerSupabaseClient();
  const canonicalSlug = await resolveCanonicalSlug(inputSlug);
  if (!canonicalSlug) return null;

  const [canonicalResult, printingsResult, rawMetricsResult, gradedMetricsResult] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number, language")
      .eq("slug", canonicalSlug)
      .maybeSingle<CanonicalCardRow>(),
    supabase
      .from("card_printings")
      .select("id, canonical_slug, finish, finish_detail, edition, stamp, image_url")
      .eq("canonical_slug", canonicalSlug)
      .order("edition", { ascending: false })
      .order("finish", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("card_metrics")
      .select("printing_id, signal_trend_strength, signal_breakout, signal_value_zone, signals_as_of_ts, liquidity_score, snapshot_count_30d")
      .eq("canonical_slug", canonicalSlug)
      .eq("grade", "RAW"),
    supabase
      .from("variant_metrics")
      .select("printing_id, provider, grade, signal_trend, signal_breakout, signal_value, signals_as_of_ts, history_points_30d")
      .eq("canonical_slug", canonicalSlug)
      .not("printing_id", "is", null)
      .in("provider", [...GRADED_PROVIDERS])
      .in("grade", [...GRADE_BUCKETS]),
  ]);

  if (canonicalResult.error) throw new Error(`canonical_cards: ${canonicalResult.error.message}`);
  if (printingsResult.error) throw new Error(`card_printings: ${printingsResult.error.message}`);
  if (rawMetricsResult.error) throw new Error(`card_metrics: ${rawMetricsResult.error.message}`);
  if (gradedMetricsResult.error) throw new Error(`variant_metrics: ${gradedMetricsResult.error.message}`);

  const canonical = canonicalResult.data;
  const printings = printingsResult.data;
  const rawMetrics = rawMetricsResult.data;
  const gradedMetrics = gradedMetricsResult.data;

  if (!canonical) return null;

  const printingRows = (printings ?? []) as CardPrintingRow[];
  const rawMetricMap = new Map<string, RawMetricRow>();
  for (const row of (rawMetrics ?? []) as RawMetricRow[]) {
    if (row.printing_id) rawMetricMap.set(row.printing_id, row);
  }

  const rawVariants = printingRows.map((row) => {
    const metricsRow = rawMetricMap.get(row.id) ?? null;
    const metrics = buildRawMetrics(metricsRow);
    return {
      ...buildPrintingPill(row),
      available:
        !!metricsRow &&
        (
          metricsRow.signals_as_of_ts !== null ||
          (metricsRow.snapshot_count_30d ?? 0) >= RAW_AVAILABILITY_THRESHOLD
        ),
      metrics,
    };
  });

  const gradedRows = ((gradedMetrics ?? []) as GradedMetricRow[])
    .filter((row): row is GradedMetricRow & { printing_id: string } => {
      return !!row.printing_id
        && (GRADED_PROVIDERS as readonly string[]).includes(row.provider)
        && (GRADE_BUCKETS as readonly string[]).includes(row.grade);
    });

  const gradedMatrix = gradedRows.map((row) => ({
    printingId: row.printing_id,
    provider: row.provider as GradedProvider,
    gradeBucket: row.grade as GradeBucket,
    available:
      row.signals_as_of_ts !== null ||
      (row.history_points_30d ?? 0) >= GRADED_AVAILABILITY_THRESHOLD,
    metrics: buildGradedMetrics(row),
  }));

  const hasAnyGraded = gradedMatrix.some((row) => row.available || row.metrics !== null);
  const defaultMode = hasAnyGraded ? "GRADED" : "RAW";
  const defaultPrintingId = pickBestPrintingId(rawVariants, gradedMatrix, defaultMode);
  const defaultProvider = defaultMode === "GRADED"
    ? pickDefaultProvider(gradedMatrix, defaultPrintingId)
    : null;
  const defaultGradeBucket = defaultMode === "GRADED"
    ? pickDefaultGradeBucket(gradedMatrix, defaultPrintingId, defaultProvider)
    : null;

  const providers = GRADED_PROVIDERS.map((provider) => ({
    provider,
    available: gradedMatrix.some((row) => row.provider === provider && row.available),
  }));

  const grades = GRADE_BUCKETS.map((gradeBucket) => ({
    gradeBucket,
    available: gradedMatrix.some((row) => row.gradeBucket === gradeBucket && row.available),
  }));

  return {
    canonical: {
      slug: canonical.slug,
      name: canonical.canonical_name,
      setName: canonical.set_name,
      year: canonical.year,
      cardNumber: canonical.card_number,
      language: canonical.language,
    },
    defaults: {
      mode: defaultMode,
      printingId: defaultPrintingId,
      provider: defaultProvider,
      gradeBucket: defaultGradeBucket,
    },
    raw: {
      variants: rawVariants,
    },
    graded: {
      providers,
      grades,
      matrix: gradedMatrix,
    },
  };
}
