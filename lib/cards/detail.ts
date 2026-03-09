import { dbPublic } from "@/lib/db";
import {
  averageProviderUsdPrice,
  buildProviderPriceDisplay,
  type ProviderPriceDisplay,
} from "@/lib/pricing/provider-price-display";
import {
  GRADED_PROVIDERS,
  GRADE_BUCKETS,
  type CardDetailMetrics,
  type CardDetailPriceCompare,
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
  liquidity_score: number | null;
  snapshot_count_30d: number | null;
  justtcg_price: number | null;
  scrydex_price: number | null;
  pokemontcg_price?: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
};

type RawSignalRow = {
  printing_id: string | null;
  provider: string;
  provider_as_of_ts: string | null;
  history_points_30d: number | null;
};

type GradedMetricRow = {
  printing_id: string | null;
  provider: string;
  grade: string;
  provider_as_of_ts: string | null;
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

function normalizeRawProviderName(provider: string | null | undefined): "JUSTTCG" | "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "JUSTTCG") return "JUSTTCG";
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
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

function buildRawMetrics(metricsRow: RawMetricRow | null, signalRows: RawSignalRow[]): CardDetailMetrics | null {
  if (!metricsRow && signalRows.length === 0) return null;
  let latestAsOf: string | null = null;
  let points30d = metricsRow?.snapshot_count_30d ?? null;
  for (const row of signalRows) {
    if (row.provider_as_of_ts && (!latestAsOf || row.provider_as_of_ts > latestAsOf)) {
      latestAsOf = row.provider_as_of_ts;
    }
    const rowPoints = row.history_points_30d;
    if (typeof rowPoints === "number" && Number.isFinite(rowPoints)) {
      points30d = points30d === null ? rowPoints : Math.max(points30d, rowPoints);
    }
  }
  // Signal columns (trend, breakout, valueZone) are paywalled — always null from public views.
  return {
    trend: null,
    breakout: null,
    valueZone: null,
    asOf: latestAsOf,
    liquidityScore: metricsRow?.liquidity_score ?? null,
    points30d,
  };
}

async function buildPriceCompare(params: {
  supabase: ReturnType<typeof dbPublic>;
  metricsRow: RawMetricRow | null;
  providerAsOfByProvider?: Partial<Record<"JUSTTCG" | "SCRYDEX", string | null>>;
}): Promise<CardDetailPriceCompare | null> {
  const { supabase, metricsRow } = params;
  const providerAsOfByProvider = params.providerAsOfByProvider ?? {};

  const justtcgDisplay = await buildProviderPriceDisplay({
    supabase,
    provider: "JUSTTCG",
    sourcePrice: metricsRow?.justtcg_price ?? null,
    sourceCurrency: "USD",
    asOf: providerAsOfByProvider.JUSTTCG ?? null,
  });

  const scrydexSourcePrice = metricsRow?.scrydex_price ?? metricsRow?.pokemontcg_price ?? null;
  const scrydexDisplay = await buildProviderPriceDisplay({
    supabase,
    provider: "SCRYDEX",
    sourcePrice: scrydexSourcePrice,
    sourceCurrency: "USD",
    asOf: providerAsOfByProvider.SCRYDEX ?? null,
  });

  if (!metricsRow && justtcgDisplay.usdPrice === null && scrydexDisplay.usdPrice === null) return null;

  const providers: ProviderPriceDisplay[] = [justtcgDisplay, scrydexDisplay];
  const usdAverage = averageProviderUsdPrice(providers);
  const asOf = scrydexDisplay.asOf ?? justtcgDisplay.asOf ?? metricsRow?.market_price_as_of ?? null;

  return {
    justtcgPrice: justtcgDisplay.usdPrice,
    scrydexPrice: scrydexDisplay.usdPrice,
    pokemontcgPrice: scrydexDisplay.usdPrice,
    marketPrice: usdAverage ?? metricsRow?.market_price ?? null,
    asOf,
    providers,
  };
}

function buildGradedMetrics(row: GradedMetricRow | null): CardDetailMetrics | null {
  if (!row) return null;
  // Signal columns paywalled — always null from public views.
  return {
    trend: null,
    breakout: null,
    valueZone: null,
    asOf: row.provider_as_of_ts,
    liquidityScore: null,
    points30d: row.history_points_30d,
  };
}

export async function resolveCanonicalSlug(input: string): Promise<string | null> {
  const supabase = dbPublic();
  const slug = input.trim();
  if (!slug) return null;

  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle<{ slug: string }>();
  if (canonical?.slug) return canonical.slug;
  return null;
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
  const supabase = dbPublic();
  const canonicalSlug = await resolveCanonicalSlug(inputSlug);
  if (!canonicalSlug) return null;

  const [canonicalResult, printingsResult, rawMetricsResult, rawSignalsResult, gradedMetricsResult] = await Promise.all([
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
      .from("public_card_metrics")
      .select("printing_id, liquidity_score, snapshot_count_30d, justtcg_price, scrydex_price, pokemontcg_price, market_price, market_price_as_of")
      .eq("canonical_slug", canonicalSlug)
      .eq("grade", "RAW"),
    supabase
      .from("public_variant_metrics")
      .select("printing_id, provider, provider_as_of_ts, history_points_30d")
      .eq("canonical_slug", canonicalSlug)
      .eq("grade", "RAW")
      .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
      .not("printing_id", "is", null),
    supabase
      .from("public_variant_metrics")
      .select("printing_id, provider, grade, provider_as_of_ts, history_points_30d")
      .eq("canonical_slug", canonicalSlug)
      .not("printing_id", "is", null)
      .in("provider", [...GRADED_PROVIDERS])
      .in("grade", [...GRADE_BUCKETS]),
  ]);

  if (canonicalResult.error) throw new Error(`canonical_cards: ${canonicalResult.error.message}`);
  if (printingsResult.error) throw new Error(`card_printings: ${printingsResult.error.message}`);
  if (rawMetricsResult.error) throw new Error(`card_metrics: ${rawMetricsResult.error.message}`);
  if (rawSignalsResult.error) throw new Error(`variant_metrics RAW: ${rawSignalsResult.error.message}`);
  if (gradedMetricsResult.error) throw new Error(`variant_metrics: ${gradedMetricsResult.error.message}`);

  const canonical = canonicalResult.data;
  const printings = printingsResult.data;
  const rawMetrics = rawMetricsResult.data;
  const rawSignals = rawSignalsResult.data;
  const gradedMetrics = gradedMetricsResult.data;

  if (!canonical) return null;

  const printingRows = (printings ?? []) as CardPrintingRow[];
  const rawMetricMap = new Map<string, RawMetricRow>();
  let canonicalRawMetric: RawMetricRow | null = null;
  for (const row of (rawMetrics ?? []) as RawMetricRow[]) {
    if (row.printing_id) rawMetricMap.set(row.printing_id, row);
    else if (!canonicalRawMetric) canonicalRawMetric = row;
  }
  const rawSignalMap = new Map<string, RawSignalRow[]>();
  for (const row of (rawSignals ?? []) as RawSignalRow[]) {
    if (!row.printing_id) continue;
    const bucket = rawSignalMap.get(row.printing_id) ?? [];
    bucket.push(row);
    rawSignalMap.set(row.printing_id, bucket);
  }
  const rawVariants = await Promise.all(printingRows.map(async (row) => {
    const metricsRow = rawMetricMap.get(row.id) ?? null;
    const signalRows = rawSignalMap.get(row.id) ?? [];
    const metrics = buildRawMetrics(metricsRow, signalRows);
    const providerAsOfByProvider: Partial<Record<"JUSTTCG" | "SCRYDEX", string | null>> = {};
    for (const signalRow of signalRows) {
      const provider = normalizeRawProviderName(signalRow.provider);
      const ts = signalRow.provider_as_of_ts;
      if (!provider || !ts) continue;
      const current = providerAsOfByProvider[provider];
      if (!current || ts > current) providerAsOfByProvider[provider] = ts;
    }
    const pricing = await buildPriceCompare({
      supabase,
      metricsRow,
      providerAsOfByProvider,
    });
    return {
      ...buildPrintingPill(row),
      available:
        !!metrics &&
        Math.max(...signalRows.map((item) => item.history_points_30d ?? 0), metricsRow?.snapshot_count_30d ?? 0) >= RAW_AVAILABILITY_THRESHOLD,
      metrics,
      pricing,
    };
  }));

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
      (row.provider === "PSA" && row.provider_as_of_ts !== null) ||
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
    pricing: await buildPriceCompare({
      supabase,
      metricsRow: canonicalRawMetric,
    }),
    graded: {
      providers,
      grades,
      matrix: gradedMatrix,
    },
  };
}
