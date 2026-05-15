import { dbPublic } from "@/lib/db";
import { resolveCardImage } from "@/lib/images/resolve";
import {
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
  type EditionKind,
  type FinishGroup,
  type FinishKind,
  type FinishStampVariant,
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

type TranslationRow = {
  en_slug: string;
  jp_slug: string;
};

type CardPrintingRow = {
  id: string;
  canonical_slug: string;
  finish: string;
  finish_detail: string | null;
  edition: string;
  stamp: string | null;
  image_url: string | null;
  mirrored_image_url: string | null;
  mirrored_thumb_url: string | null;
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
  switch (stamp.toUpperCase()) {
    case "POKE_BALL_PATTERN":
      return "Poké Ball";
    case "MASTER_BALL_PATTERN":
      return "Master Ball";
    case "SHADOWLESS":
      return "Shadowless";
    default:
      return toTitleLabel(stamp);
  }
}

function normalizeRawProviderName(provider: string | null | undefined): "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
}

type FinishGroupInputRow = {
  id: string;
  finish: string;
  edition: string;
  stamp: string | null;
  image_url?: string | null;
  mirrored_image_url?: string | null;
  mirrored_thumb_url?: string | null;
};

const FINISH_PRIORITY: Record<FinishKind, number> = {
  NON_HOLO: 0,
  HOLO: 1,
  REVERSE_HOLO: 2,
  ALT_HOLO: 3,
  UNKNOWN: 4,
};

const FINISH_GROUP_LABEL: Record<FinishKind, string> = {
  NON_HOLO: "Regular",
  HOLO: "Holo",
  REVERSE_HOLO: "Reverse Holo",
  ALT_HOLO: "Alt Art",
  UNKNOWN: "Variant",
};

function asFinishKind(value: string): FinishKind {
  switch (value) {
    case "NON_HOLO":
    case "HOLO":
    case "REVERSE_HOLO":
    case "ALT_HOLO":
      return value;
    default:
      return "UNKNOWN";
  }
}

function asEditionKind(value: string): EditionKind {
  switch (value) {
    case "UNLIMITED":
    case "FIRST_EDITION":
      return value;
    default:
      return "UNKNOWN";
  }
}

function buildStampVariantLabel(stamp: string | null, edition: EditionKind): string {
  const stampText = stamp ? stampPillLabel(stamp) : null;
  const isFirstEd = edition === "FIRST_EDITION";
  if (stampText && isFirstEd) return `1st Ed · ${stampText}`;
  if (stampText) return stampText;
  if (isFirstEd) return "1st Edition";
  return "Standard";
}

function isStandardVariant(row: FinishGroupInputRow): boolean {
  return row.stamp === null && asEditionKind(row.edition) === "UNLIMITED";
}

function resolveImageUrl(row: FinishGroupInputRow): string | null {
  return row.mirrored_image_url ?? row.image_url ?? null;
}

export function buildFinishGroups(rows: FinishGroupInputRow[]): FinishGroup[] {
  const buckets = new Map<FinishKind, FinishGroupInputRow[]>();
  for (const row of rows) {
    const finish = asFinishKind(row.finish);
    const bucket = buckets.get(finish) ?? [];
    bucket.push(row);
    buckets.set(finish, bucket);
  }

  const groups: FinishGroup[] = [];
  const orderedFinishes = [...buckets.keys()].sort(
    (a, b) => FINISH_PRIORITY[a] - FINISH_PRIORITY[b],
  );

  for (const finish of orderedFinishes) {
    const bucket = buckets.get(finish) ?? [];
    const sortedRows = [...bucket].sort((a, b) => {
      const aStandard = isStandardVariant(a) ? 0 : 1;
      const bStandard = isStandardVariant(b) ? 0 : 1;
      if (aStandard !== bStandard) return aStandard - bStandard;
      const aLabel = buildStampVariantLabel(a.stamp, asEditionKind(a.edition));
      const bLabel = buildStampVariantLabel(b.stamp, asEditionKind(b.edition));
      const labelDelta = aLabel.localeCompare(bLabel);
      if (labelDelta !== 0) return labelDelta;
      return a.id.localeCompare(b.id);
    });

    const variants: FinishStampVariant[] = sortedRows.map((row) => {
      const edition = asEditionKind(row.edition);
      return {
        printingId: row.id,
        stamp: row.stamp,
        stampLabel: buildStampVariantLabel(row.stamp, edition),
        edition,
        imageUrl: resolveImageUrl(row),
      };
    });

    const standard = sortedRows.find(isStandardVariant);
    const defaultPrintingId = standard?.id ?? variants[0]?.printingId;
    if (!defaultPrintingId) continue;

    groups.push({
      finish,
      finishLabel: FINISH_GROUP_LABEL[finish],
      defaultPrintingId,
      variants,
    });
  }

  return groups;
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
    // Prefer mirrored full image; fall back to the raw Scrydex URL when the
    // mirror cron hasn't picked up this row yet.
    imageUrl: resolveCardImage(row).full,
  };
}

function buildRawMetrics(metricsRow: RawMetricRow | null, _signalRows: RawSignalRow[]): CardDetailMetrics | null {
  if (!metricsRow) return null;
  const hasLivePrice = metricsRow.market_price !== null;
  // Signal columns (trend, breakout, valueZone) are paywalled — always null from public views.
  return {
    trend: null,
    breakout: null,
    valueZone: null,
    asOf: hasLivePrice ? metricsRow.market_price_as_of : null,
    liquidityScore: hasLivePrice ? (metricsRow.liquidity_score ?? null) : null,
    points30d: hasLivePrice ? (metricsRow.snapshot_count_30d ?? null) : null,
  };
}

async function buildPriceCompare(params: {
  supabase: ReturnType<typeof dbPublic>;
  metricsRow: RawMetricRow | null;
}): Promise<CardDetailPriceCompare | null> {
  const { supabase, metricsRow } = params;
  const scrydexSourcePrice = metricsRow?.market_price ?? null;
  const scrydexAsOf = scrydexSourcePrice !== null ? (metricsRow?.market_price_as_of ?? null) : null;
  if (scrydexSourcePrice === null) return null;

  const scrydexDisplay = await buildProviderPriceDisplay({
    supabase,
    provider: "SCRYDEX",
    sourcePrice: scrydexSourcePrice,
    sourceCurrency: "USD",
    asOf: scrydexAsOf,
  });

  const providers: ProviderPriceDisplay[] = [scrydexDisplay];

  return {
    justtcgPrice: null,
    scrydexPrice: scrydexDisplay.usdPrice,
    pokemontcgPrice: null,
    marketPrice: scrydexDisplay.usdPrice,
    asOf: scrydexAsOf,
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

  const { data: aliased } = await supabase
    .from("card_aliases")
    .select("canonical_slug")
    .eq("alias", slug)
    .limit(1)
    .maybeSingle<{ canonical_slug: string }>();
  if (aliased?.canonical_slug) return aliased.canonical_slug;

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

  const [canonicalResult, printingsResult, rawMetricsResult, rawSignalsResult, gradedMetricsResult, translationResult] = await Promise.all([
    supabase
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number, language")
      .eq("slug", canonicalSlug)
      .maybeSingle<CanonicalCardRow>(),
    supabase
      .from("card_printings")
      .select("id, canonical_slug, finish, finish_detail, edition, stamp, image_url, mirrored_image_url, mirrored_thumb_url")
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
      .in("provider", ["SCRYDEX", "POKEMON_TCG_API"])
      .not("printing_id", "is", null),
    supabase
      .from("public_variant_metrics")
      .select("printing_id, provider, grade, provider_as_of_ts, history_points_30d")
      .eq("canonical_slug", canonicalSlug)
      .not("printing_id", "is", null)
      .in("provider", [...GRADED_PROVIDERS])
      .in("grade", [...GRADE_BUCKETS]),
    // Cross-language pairing for the CardDetailView EN/JP toggle. Reads
    // rank=0 (primary) only; .or() searches both sides of the junction
    // since canonicalSlug may be either the EN or JP partner.
    //
    // Why .order().limit(1) instead of .maybeSingle(): the table's
    // primary key is (en_slug, jp_slug), so two different EN reprints
    // CAN independently pick the same JP slug as rank=0 — that's
    // legitimate data, not a backfill bug. When the user opens the
    // JP card's detail page, the `jp_slug.eq.X AND rank=0` half of
    // the .or() matches multiple rows and .maybeSingle() would
    // surface a PGRST116 multi-row error, which my error handler
    // treats as "no pairing" and hides the toggle. Ordering by
    // confidence DESC and limiting picks the strongest pairing
    // deterministically.
    supabase
      .from("card_translations")
      .select("en_slug, jp_slug")
      .or(`en_slug.eq.${canonicalSlug},jp_slug.eq.${canonicalSlug}`)
      .eq("rank", 0)
      .order("confidence", { ascending: false })
      .limit(1),
  ]);

  if (canonicalResult.error) throw new Error(`canonical_cards: ${canonicalResult.error.message}`);
  if (printingsResult.error) throw new Error(`card_printings: ${printingsResult.error.message}`);
  if (rawMetricsResult.error) throw new Error(`card_metrics: ${rawMetricsResult.error.message}`);
  if (rawSignalsResult.error) throw new Error(`variant_metrics RAW: ${rawSignalsResult.error.message}`);
  if (gradedMetricsResult.error) throw new Error(`variant_metrics: ${gradedMetricsResult.error.message}`);
  // card_translations is a soft dependency — if the table is missing
  // (pre-migration) or the query errors transiently, the toggle just
  // doesn't render. Log and continue rather than blow up the whole
  // detail response.
  if (translationResult.error) {
    console.warn(`[buildCardDetailResponse] card_translations lookup failed: ${translationResult.error.message}`);
  }

  const canonical = canonicalResult.data;
  const printings = printingsResult.data;
  const rawMetrics = rawMetricsResult.data;
  const rawSignals = rawSignalsResult.data;
  const gradedMetrics = gradedMetricsResult.data;
  // .limit(1) returns an array, not a single object. The query is
  // already ordered by confidence DESC so [0] is the strongest
  // pairing — picks deterministically when a JP slug is paired by
  // multiple EN reprints.
  const translationRows = translationResult.error ? null : (translationResult.data as TranslationRow[] | null);
  const translation = translationRows && translationRows.length > 0 ? translationRows[0] : null;

  if (!canonical) return null;

  // Resolve the paired side. The canonicalSlug appears as either en_slug
  // or jp_slug in the junction row; the OTHER side is the pairing.
  // pairedLanguage is the language of the paired slug — derived from
  // canonical.language by inversion when known, else looked up.
  let pairedSlug: string | null = null;
  let pairedLanguage: "EN" | "JP" | null = null;
  if (translation) {
    if (translation.en_slug === canonicalSlug) {
      pairedSlug = translation.jp_slug;
      pairedLanguage = "JP";
    } else if (translation.jp_slug === canonicalSlug) {
      pairedSlug = translation.en_slug;
      pairedLanguage = "EN";
    }
  }

  // Paired card's image URL. iOS uses this to populate the toggle's
  // stub MarketCard so the hero swaps directly from EN art to JP art
  // (or vice versa) without falling back to heroPlaceholder while
  // the metrics round-trip lands. Prefer the mirror; fall back to
  // the raw Scrydex URL when the image-mirror cron hasn't picked
  // this slug up yet. Issued as a separate query rather than a
  // PostgREST join because the FK direction depends on which side
  // of the junction is the paired slug, and the conditional makes
  // a join awkward to express. One ~30ms hop is cheap; the toggle
  // UX win is worth it.
  let pairedImageUrl: string | null = null;
  if (pairedSlug) {
    const { data: paired } = await supabase
      .from("canonical_cards")
      .select("mirrored_primary_image_url, primary_image_url")
      .eq("slug", pairedSlug)
      .maybeSingle<{ mirrored_primary_image_url: string | null; primary_image_url: string | null }>();
    pairedImageUrl = paired?.mirrored_primary_image_url ?? paired?.primary_image_url ?? null;
  }

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
    const pricing = await buildPriceCompare({
      supabase,
      metricsRow,
    });
    return {
      ...buildPrintingPill(row),
      available:
        !!metrics &&
        (metrics.points30d ?? 0) >= RAW_AVAILABILITY_THRESHOLD,
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
      pairedSlug,
      pairedLanguage,
      pairedImageUrl,
    },
    defaults: {
      mode: defaultMode,
      printingId: defaultPrintingId,
      provider: defaultProvider,
      gradeBucket: defaultGradeBucket,
    },
    raw: {
      variants: rawVariants,
      finishGroups: buildFinishGroups(printingRows),
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
