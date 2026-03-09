/**
 * README
 * Primitives: PageShell, NavBar, GroupedSection, GroupCard, StatRow, StatTile, SegmentedControl, Pill, Skeleton.
 * Layout: sticky compact nav → freefloating hero → variant selector → market intelligence →
 *         grade ladder (RAW / PSA 9 / PSA 10 with premiums + TCG reference) → live listings.
 * iOS grouped rules: matte dark surfaces, consistent radii and spacing, restrained separators,
 * and touch targets sized for mobile-first interaction.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CardModeToggle from "@/components/card-mode-toggle";
import CardViewTracker from "@/components/card-view-tracker";
import CollapsibleSection from "@/components/collapsible-section";
import EbayListings from "@/components/ebay-listings";
import { GroupedSection, PageShell, Pill, SegmentedControl, StatStripItem } from "@/components/ios-grouped-ui";
import MarketPulse from "@/components/market-pulse";
import MarketSummaryCard from "@/components/market-summary-card";
import PopAlphaScoutPreview from "@/components/popalpha-scout-preview";
import PokeTraceBetaCard from "@/components/poketrace-beta-card";
import CardTileMini from "@/components/card-tile-mini";
import type { HomepageCard } from "@/lib/data/homepage";
import { buildEbaySearchQueries, type GradeSelection, type GradedSource } from "@/lib/ebay-query";
import { buildPrintingPill } from "@/lib/cards/detail";
import { getCardViewSnapshot } from "@/lib/data/card-views";
import { getCommunityPulseSnapshot } from "@/lib/data/community-pulse";
import { getRelatedCardCarousels } from "@/lib/data/related-cards";
import { buildGradedVariantRef, buildRawVariantRef } from "@/lib/identity/variant-ref";
import { dbPublic } from "@/lib/db";
import { buildAssetViewModel } from "@/lib/data/assets";
import { resolveWeightedMarketPrice } from "@/lib/pricing/market-confidence";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
};

type CardPrintingRow = {
  id: string;
  language: string;
  set_code: string | null;
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "ALT_HOLO" | "UNKNOWN";
  finish_detail: string | null;
  edition: "UNLIMITED" | "FIRST_EDITION" | "UNKNOWN";
  stamp: string | null;
  image_url: string | null;
  rarity: string | null;
};

type SnapshotRow = {
  active_listings_7d: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
  market_price: number | null;
  market_price_as_of: string | null;
  justtcg_price: number | null;
  scrydex_price: number | null;
  pokemontcg_price: number | null;
};

type CardProfileRow = {
  summary_short: string;
  summary_long: string | null;
};

const DEFAULT_BACK_HREF = "/search";
const VIEW_MODES = ["RAW", "GRADED"] as const;
const GRADED_SOURCES = ["PSA", "TAG", "BGS", "CGC"] as const;
const GRADE_BUCKETS = ["LE_7", "G8", "G9", "G10"] as const;

type ViewMode = (typeof VIEW_MODES)[number];
type GradeBucket = (typeof GRADE_BUCKETS)[number];

type GradedAvailabilityRow = {
  provider: GradedSource;
  grade: GradeBucket;
  provider_as_of_ts: string | null;
  history_points_30d: number | null;
};

type GradedPriceHistoryRow = {
  variant_ref: string;
  price: number;
  currency: string | null;
  ts: string;
};

type RawProviderHistoryRow = {
  provider: string;
  variant_ref: string;
  ts: string;
};

type RawProviderMetricRow = {
  provider: string;
  provider_as_of_ts: string | null;
};

type RawParityRow = {
  parity_status: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
};

function finishLabel(finish: CardPrintingRow["finish"]): string {
  const map: Record<CardPrintingRow["finish"], string> = {
    NON_HOLO: "Non-Holo",
    HOLO: "Holo",
    REVERSE_HOLO: "Reverse Holo",
    ALT_HOLO: "Alt Holo",
    UNKNOWN: "Unknown",
  };
  return map[finish];
}

function finishPriority(finish: CardPrintingRow["finish"]): number {
  const order: Record<CardPrintingRow["finish"], number> = {
    HOLO: 0,
    REVERSE_HOLO: 1,
    NON_HOLO: 2,
    ALT_HOLO: 3,
    UNKNOWN: 4,
  };
  return order[finish] ?? 9;
}

function sortPrintings(a: CardPrintingRow, b: CardPrintingRow): number {
  const finishDelta = finishPriority(a.finish) - finishPriority(b.finish);
  if (finishDelta !== 0) return finishDelta;
  if (a.edition !== b.edition) return a.edition === "FIRST_EDITION" ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function rawVariantSortPriority(printing: CardPrintingRow): number {
  const order: Record<CardPrintingRow["finish"], number> = {
    NON_HOLO: 0,
    REVERSE_HOLO: 1,
    HOLO: 2,
    ALT_HOLO: 3,
    UNKNOWN: 4,
  };
  return order[printing.finish] ?? 9;
}

function defaultPrintingPriority(printing: CardPrintingRow): number {
  let score = 0;
  if (printing.finish === "NON_HOLO") score += 100;
  else if (printing.finish === "HOLO") score += 70;
  else if (printing.finish === "REVERSE_HOLO") score += 50;
  else if (printing.finish === "ALT_HOLO") score += 30;

  if (printing.edition === "UNLIMITED") score += 20;
  else if (printing.edition === "FIRST_EDITION") score += 10;

  if (!printing.stamp) score += 10;
  if (printing.image_url) score += 5;

  return score;
}

function chooseDefaultPrinting(printings: CardPrintingRow[]): CardPrintingRow | null {
  if (printings.length === 0) return null;
  return [...printings].sort((a, b) => {
    const scoreDelta = defaultPrintingPriority(b) - defaultPrintingPriority(a);
    if (scoreDelta !== 0) return scoreDelta;
    return sortPrintings(a, b);
  })[0] ?? null;
}

function selectedGrade(gradeRaw: string | undefined): GradeSelection {
  const upper = (gradeRaw ?? "RAW").toUpperCase();
  if (upper === "PSA9" || upper === "PSA10" || upper === "RAW") return upper;
  return "RAW";
}

function selectedViewMode(modeRaw: string | undefined, gradeRaw: string | undefined): ViewMode {
  const upper = (modeRaw ?? "").toUpperCase();
  if (upper === "RAW" || upper === "GRADED") return upper;
  return selectedGrade(gradeRaw) === "RAW" ? "RAW" : "GRADED";
}

function legacyGradeToBucket(gradeRaw: string | undefined): GradeBucket | null {
  const parsed = selectedGrade(gradeRaw);
  if (parsed === "PSA9") return "G9";
  if (parsed === "PSA10") return "G10";
  return null;
}

function selectedBucket(bucketRaw: string | undefined, gradeRaw: string | undefined): GradeBucket | null {
  const upper = (bucketRaw ?? "").toUpperCase();
  if ((GRADE_BUCKETS as readonly string[]).includes(upper)) return upper as GradeBucket;
  return legacyGradeToBucket(gradeRaw);
}

function selectedProvider(providerRaw: string | undefined): GradedSource | null {
  const upper = (providerRaw ?? "").toUpperCase();
  if ((GRADED_SOURCES as readonly string[]).includes(upper)) return upper as GradedSource;
  return null;
}

function gradeBucketLabel(grade: GradeBucket): string {
  if (grade === "LE_7") return "7 or Less";
  if (grade === "G8") return "8";
  if (grade === "G9") return "9";
  if (grade === "G10") return "10";
  return grade;
}

function providerLabel(provider: GradedSource): string {
  if (provider === "BGS") return "Beckett";
  return provider;
}

function legacyGradeLabel(grade: GradeSelection): string {
  if (grade === "PSA9") return "PSA 9";
  if (grade === "PSA10") return "PSA 10";
  return "Raw";
}

function snapshotGradeForSelection(mode: ViewMode, bucket: GradeBucket | null): "RAW" | "PSA9" | "PSA10" | null {
  if (mode === "RAW") return "RAW";
  if (bucket === "G9") return "PSA9";
  if (bucket === "G10") return "PSA10";
  return null;
}

function printingOptionLabel(printing: CardPrintingRow): string | null {
  const finish = finishLabel(printing.finish);
  const safeFinish = finish === "Unknown" ? null : finish;
  return [safeFinish, printing.edition === "FIRST_EDITION" ? "1st Ed" : null, printing.stamp]
    .filter((value) => Boolean(value))
    .join(" • ") || null;
}

function rawVariantSegmentLabel(
  printing: CardPrintingRow,
  allPrintings: CardPrintingRow[],
): string {
  const distinctFinishes = new Set(
    allPrintings
      .map((row) => row.finish)
      .filter((value) => value && value !== "UNKNOWN")
  );
  const distinctEditions = new Set(
    allPrintings
      .map((row) => row.edition)
      .filter((value) => value && value !== "UNKNOWN")
  );

  if (printing.stamp) return buildPrintingPill({
    id: printing.id,
    canonical_slug: "",
    finish: printing.finish,
    finish_detail: printing.finish_detail,
    edition: printing.edition,
    stamp: printing.stamp,
    image_url: printing.image_url,
  }).pillLabel;

  const finishText = printing.finish !== "UNKNOWN" ? finishLabel(printing.finish) : null;
  if (distinctFinishes.size > 1 && finishText) {
    if (printing.edition === "FIRST_EDITION") return `1st ${finishText}`;
    return finishText;
  }

  if (printing.edition === "FIRST_EDITION") {
    return finishText ? `1st ${finishText}` : "1st Edition";
  }

  if (distinctEditions.size > 1 && printing.edition !== "UNKNOWN") {
    return printing.edition === "UNLIMITED" && finishText
      ? `${finishText}`
      : printing.edition === "UNLIMITED"
        ? "Unlimited"
        : "1st Edition";
  }

  return finishText ?? "Variant";
}

function resolveBackHref(returnTo: string | undefined): string {
  const trimmed = (returnTo ?? "").trim();
  if (!trimmed) return DEFAULT_BACK_HREF;
  if (!trimmed.startsWith("/search")) return DEFAULT_BACK_HREF;
  return trimmed;
}

function toggleHref(
  slug: string,
  printingId: string | null,
  debugEnabled: boolean,
  returnTo?: string,
  opts?: {
    mode?: ViewMode;
    provider?: GradedSource | null;
    bucket?: GradeBucket | null;
    marketWindow?: "7d" | "30d" | "90d";
  },
): string {
  const params = new URLSearchParams();
  if (printingId) params.set("printing", printingId);
  const mode = opts?.mode;
  const bucket = opts?.bucket;
  const provider = opts?.provider;
  const marketWindow = opts?.marketWindow;
  if (mode && mode !== "RAW") params.set("mode", mode);
  if (provider) params.set("provider", provider);
  if (bucket) params.set("bucket", bucket);
  if (bucket === "G9") params.set("grade", "PSA9");
  else if (bucket === "G10") params.set("grade", "PSA10");
  if (marketWindow && marketWindow !== "30d") params.set("marketWindow", marketWindow);
  if (debugEnabled) params.set("debug", "1");
  const backHref = resolveBackHref(returnTo);
  if (backHref !== DEFAULT_BACK_HREF) params.set("returnTo", backHref);
  const qs = params.toString();
  const path = qs ? `/c/${encodeURIComponent(slug)}?${qs}` : `/c/${encodeURIComponent(slug)}`;
  return `${path}#content`;
}

function selectedMarketWindow(raw: string | undefined): "7d" | "30d" | "90d" {
  if (raw === "7d") return "7d";
  return raw === "90d" ? "90d" : "30d";
}

function setHref(setName: string | null): string | null {
  if (!setName) return null;
  return `/sets/${encodeURIComponent(setName)}`;
}

function rarityColor(rarity: string | null): { label: string; color: string; borderColor: string; bgColor: string } | null {
  if (!rarity) return null;
  const r = rarity.toLowerCase();
  if (r === "common") return { label: "Common", color: "#D0D0D0", borderColor: "rgba(208,208,208,0.25)", bgColor: "rgba(208,208,208,0.06)" };
  if (r === "uncommon") return { label: "Uncommon", color: "#4ADE80", borderColor: "rgba(74,222,128,0.25)", bgColor: "rgba(74,222,128,0.06)" };
  if (r === "rare" || r.includes("rare")) return { label: rarity, color: "#60A5FA", borderColor: "rgba(96,165,250,0.25)", bgColor: "rgba(96,165,250,0.06)" };
  if (r.includes("mythic") || r.includes("very rare") || r.includes("illustration") || r === "promo") return { label: rarity, color: "#C084FC", borderColor: "rgba(192,132,252,0.25)", bgColor: "rgba(192,132,252,0.06)" };
  if (r.includes("legend") || r.includes("hyper") || r.includes("secret") || r.includes("special art") || r === "sar") return { label: rarity, color: "#FB923C", borderColor: "rgba(251,146,60,0.25)", bgColor: "rgba(251,146,60,0.06)" };
  // Fallback for unknown rarities
  return { label: rarity, color: "#999", borderColor: "rgba(153,153,153,0.25)", bgColor: "rgba(153,153,153,0.06)" };
}

function marketStatusSignal(
  active7d: number | null,
): { label: string; tone: "positive" | "warning" | "neutral" } {
  if (active7d === null || active7d === undefined) return { label: "Market Forming", tone: "neutral" };
  if (active7d <= 4) return { label: "Scarce", tone: "positive" };
  return { label: "Abundant", tone: "neutral" };
}

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatAsOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeRawProviderName(provider: string | null | undefined): "JUSTTCG" | "SCRYDEX" | null {
  const normalized = String(provider ?? "").trim().toUpperCase();
  if (normalized === "JUSTTCG") return "JUSTTCG";
  if (normalized === "SCRYDEX" || normalized === "POKEMON_TCG_API") return "SCRYDEX";
  return null;
}

function resolveRawDisplayPrice(params: {
  justtcg: number | null;
  scrydex: number | null;
  justtcgAsOfTs: string | null;
  scrydexAsOfTs: string | null;
  justtcgPoints7d: number;
  scrydexPoints7d: number;
  fallback: number | null;
  parityStatus: "MATCH" | "MISMATCH" | "MISSING_PROVIDER" | "UNKNOWN";
}): {
  marketPrice: number | null;
  blendPolicy: string;
  confidenceScore: number;
  lowConfidence: boolean;
  sourceMix: { justtcgWeight: number; scrydexWeight: number };
} {
  const weighted = resolveWeightedMarketPrice({
    providers: [
      { provider: "JUSTTCG", price: params.justtcg, asOfTs: params.justtcgAsOfTs, points7d: params.justtcgPoints7d },
      { provider: "SCRYDEX", price: params.scrydex, asOfTs: params.scrydexAsOfTs, points7d: params.scrydexPoints7d },
    ],
    parityStatus: params.parityStatus,
    marketPriceFallback: params.fallback,
  });
  return {
    marketPrice: weighted.marketPrice ?? params.fallback,
    blendPolicy: weighted.blendPolicy,
    confidenceScore: weighted.confidenceScore,
    lowConfidence: weighted.lowConfidence,
    sourceMix: weighted.sourceMix,
  };
}

function formatSignalScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Forming";
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

function RelatedCarouselSection({
  title,
  cards,
  emptyMessage,
}: {
  title: string;
  cards: HomepageCard[];
  emptyMessage: string;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          {title}
        </h2>
      </div>
      <div
        className="mt-3 flex gap-3 overflow-x-auto pb-2 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
        style={{
          scrollSnapType: "x mandatory",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {cards.length > 0 ? cards.map((card) => (
          <CardTileMini key={`${title}-${card.slug}`} card={card} />
        )) : (
          <div className="flex min-h-[140px] w-full items-center justify-center text-[13px] text-[#444] lg:col-span-5">
            {emptyMessage}
          </div>
        )}
      </div>
    </section>
  );
}

export default async function CanonicalCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    printing?: string;
    grade?: string;
    mode?: string;
    provider?: string;
    bucket?: string;
    marketWindow?: string;
    debug?: string;
    returnTo?: string;
  }>;
}) {
  const { slug } = await params;
  const { printing, grade, mode, provider, bucket, marketWindow, debug, returnTo } = await searchParams;
  const user = await currentUser();
  const supabase = dbPublic();
  const debugEnabled = debug === "1";
  const backHref = resolveBackHref(returnTo);
  const activeMarketWindow = selectedMarketWindow(marketWindow);

  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!canonical) notFound();

  const { data: printingsData } = await supabase
    .from("card_printings")
    .select("id, language, set_code, finish, finish_detail, edition, stamp, image_url, rarity")
    .eq("canonical_slug", slug);

  const { data: cardProfile } = await supabase
    .from("card_profiles")
    .select("summary_short, summary_long")
    .eq("card_slug", slug)
    .maybeSingle<CardProfileRow>();

  const printings = ((printingsData ?? []) as CardPrintingRow[]).sort(sortPrintings);
  const viewMode = selectedViewMode(mode, grade);
  const selectedPrinting = printings.find((row) => row.id === printing) ?? chooseDefaultPrinting(printings) ?? null;
  const hasExplicitPrinting = Boolean(printing) && Boolean(printings.find((row) => row.id === printing));
  const selectedPrintingLabel = selectedPrinting ? printingOptionLabel(selectedPrinting) : null;

  const { data: gradedAvailabilityData } = selectedPrinting
    ? await supabase
        .from("public_variant_metrics")
        .select("provider, grade, provider_as_of_ts, history_points_30d")
        .eq("canonical_slug", slug)
        .eq("printing_id", selectedPrinting.id)
        .in("provider", [...GRADED_SOURCES])
        .in("grade", [...GRADE_BUCKETS])
    : { data: [] };

  const gradedAvailability = ((gradedAvailabilityData ?? []) as Array<Record<string, unknown>>)
    .filter((row): row is GradedAvailabilityRow => {
      const providerValue = row.provider;
      const gradeValue = row.grade;
      return typeof providerValue === "string"
        && typeof gradeValue === "string"
        && (GRADED_SOURCES as readonly string[]).includes(providerValue)
        && (GRADE_BUCKETS as readonly string[]).includes(gradeValue);
    })
    .filter((row) => {
      return row.provider_as_of_ts !== null
        || (row.history_points_30d ?? 0) >= 5;
    });

  const availableProviders = GRADED_SOURCES.filter((source) =>
    gradedAvailability.some((row) => row.provider === source)
  );
  const scoutUpdatedAt =
    [...gradedAvailability]
      .map((row) => row.provider_as_of_ts)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort()
      .reverse()[0] ?? null;
  const requestedProvider = selectedProvider(provider);
  const activeProvider = (requestedProvider && availableProviders.includes(requestedProvider)
    ? requestedProvider
    : null)
    ?? (availableProviders.includes("PSA") ? "PSA" : availableProviders[0] ?? null);

  const availableBucketsForProvider = activeProvider
    ? GRADE_BUCKETS.filter((gradeBucket) =>
        gradedAvailability.some((row) => row.provider === activeProvider && row.grade === gradeBucket)
      )
    : [];
  const requestedBucket = selectedBucket(bucket, grade);
  const activeBucket = (requestedBucket && availableBucketsForProvider.includes(requestedBucket)
    ? requestedBucket
    : null)
    ?? (availableBucketsForProvider.includes("G9")
      ? "G9"
      : availableBucketsForProvider.includes("G10")
        ? "G10"
        : availableBucketsForProvider[0] ?? null);

  const selectedSnapshotGrade = snapshotGradeForSelection(viewMode, activeBucket);
  const queryGradeSelection: GradeSelection = viewMode === "RAW" ? "RAW" : (activeBucket ?? "RAW");
  const legacyListingsGrade: "RAW" | "PSA9" | "PSA10" = selectedSnapshotGrade ?? "RAW";
  const gradedVariantRefsForActiveBucket = selectedPrinting && activeBucket
    ? availableProviders.map((source) => ({
        provider: source,
        variantRef: buildGradedVariantRef(selectedPrinting.id, source, activeBucket),
      }))
    : [];

  // Fetch all three grade snapshots + view model in parallel.
  // card_metrics rows are keyed by (canonical_slug, printing_id, grade).
  // For singles: printing_id = selected printing UUID. For sealed / no printing: printing_id IS NULL.
  const gradedPrintingIdForQuery = selectedPrinting?.id ?? null;
  // Default RAW view should read canonical (printing_id IS NULL) unless user explicitly picks a printing.
  const rawPrintingIdForQuery = hasExplicitPrinting ? selectedPrinting?.id ?? null : null;
  const rawVariantPrefix = rawPrintingIdForQuery ? `${rawPrintingIdForQuery}::` : null;
  const [[rawSnap, psa9Snap, psa10Snap], vm, gradedPriceHistoryQuery, rawProviderMetricsQuery, rawProviderHistoryQuery, rawParityQuery, viewSnapshot] = await Promise.all([
    Promise.all(
      (["RAW", "PSA9", "PSA10"] as const).map((g) => {
        const q = supabase
          .from("public_card_metrics")
          .select("active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d, market_price, market_price_as_of, justtcg_price, scrydex_price, pokemontcg_price")
          .eq("canonical_slug", slug)
          .eq("grade", g);
        const effectivePrintingId = g === "RAW" ? rawPrintingIdForQuery : gradedPrintingIdForQuery;
        return (effectivePrintingId != null
          ? q.eq("printing_id", effectivePrintingId)
          : q.is("printing_id", null)
        ).maybeSingle<SnapshotRow>();
      })
    ),
    buildAssetViewModel(slug, "RAW", 30, rawPrintingIdForQuery),
    gradedVariantRefsForActiveBucket.length > 0
      ? supabase
          .from("public_price_history")
          .select("variant_ref, price, currency, ts")
          .eq("canonical_slug", slug)
          .eq("provider", "SCRYDEX")
          .eq("source_window", "snapshot")
          .in("variant_ref", gradedVariantRefsForActiveBucket.map((entry) => entry.variantRef))
          .order("ts", { ascending: false })
          .limit(Math.max(gradedVariantRefsForActiveBucket.length * 4, 12))
      : Promise.resolve({ data: [] as GradedPriceHistoryRow[] }),
    (() => {
      const q = supabase
        .from("public_variant_metrics")
        .select("provider, provider_as_of_ts")
        .eq("canonical_slug", slug)
        .eq("grade", "RAW")
        .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"]);
      return (rawPrintingIdForQuery != null
        ? q.eq("printing_id", rawPrintingIdForQuery)
        : q.is("printing_id", null)
      ).limit(20);
    })(),
    (() => {
      let q = supabase
        .from("public_price_history")
        .select("provider, variant_ref, ts")
        .eq("canonical_slug", slug)
        .eq("source_window", "snapshot")
        .in("provider", ["JUSTTCG", "SCRYDEX", "POKEMON_TCG_API"])
        .order("ts", { ascending: false })
        .limit(300);
      if (rawVariantPrefix) {
        q = q.ilike("variant_ref", `${rawVariantPrefix}%`);
      }
      return q;
    })(),
    supabase
      .from("canonical_raw_provider_parity")
      .select("parity_status")
      .eq("canonical_slug", slug)
      .maybeSingle<RawParityRow>(),
    getCardViewSnapshot(slug, 14),
  ]);
  const relatedCarousels = await getRelatedCardCarousels({
    slug,
    canonicalName: canonical.canonical_name,
    setName: canonical.set_name,
    subject: canonical.subject,
    limit: 5,
  });
  const cardPulseSnapshot = await getCommunityPulseSnapshot(
    [{
      slug,
      name: canonical.canonical_name,
      set_name: canonical.set_name,
      year: canonical.year,
      market_price: null,
      change_pct: vm?.change_7d_pct ?? null,
      change_window: vm?.change_7d_pct != null ? "7D" : null,
      mover_tier: null,
      image_url: selectedPrinting?.image_url ?? null,
      sparkline_7d: [],
    }],
    user?.id ?? null,
  );
  const currentCardPulse = cardPulseSnapshot.cards[0] ?? null;

  const gradeSnapMap = {
    RAW: rawSnap.data,
    PSA9: psa9Snap.data,
    PSA10: psa10Snap.data,
  } as const;
  const gradedPriceHistoryRows = (gradedPriceHistoryQuery.data ?? []) as GradedPriceHistoryRow[];
  const rawProviderMetricRows = (rawProviderMetricsQuery.data ?? []) as RawProviderMetricRow[];
  const rawProviderHistoryRows = (rawProviderHistoryQuery.data ?? []) as RawProviderHistoryRow[];
  const rawParityStatus = rawParityQuery.data?.parity_status ?? "UNKNOWN";
  const latestGradedPriceByVariantRef = new Map<string, GradedPriceHistoryRow>();
  for (const row of gradedPriceHistoryRows) {
    if (!row.variant_ref || latestGradedPriceByVariantRef.has(row.variant_ref)) continue;
    latestGradedPriceByVariantRef.set(row.variant_ref, row);
  }

  const snapshotData = selectedSnapshotGrade ? gradeSnapMap[selectedSnapshotGrade] : null;

  const marketStatus = marketStatusSignal(snapshotData?.active_listings_7d ?? null);
  const ebayQueries = buildEbaySearchQueries({
    canonicalName: canonical.canonical_name,
    setName: canonical.set_name,
    cardNumber: canonical.card_number,
    printing: selectedPrinting
      ? {
          finish: selectedPrinting.finish,
          edition: selectedPrinting.edition,
        }
      : null,
    grade: queryGradeSelection,
    provider: viewMode === "GRADED" ? activeProvider : null,
  });
  const rawVariantOptions = [...printings]
    .sort((a, b) => {
      const finishDelta = rawVariantSortPriority(a) - rawVariantSortPriority(b);
      if (finishDelta !== 0) return finishDelta;
      return sortPrintings(a, b);
    })
    .map((row) => ({
    printingId: row.id,
    label: rawVariantSegmentLabel(row, printings),
    variantRef: buildRawVariantRef(row.id),
  }));

  const subtitleText = [
    canonical.set_name,
    canonical.card_number ? `#${canonical.card_number}` : null,
    canonical.year ? String(canonical.year) : null,
  ]
    .filter(Boolean)
    .join(" • ");

  const rawModeHref = toggleHref(
    slug,
    selectedPrinting?.id ?? null,
    debugEnabled,
    returnTo,
    {
      mode: "RAW",
      marketWindow: activeMarketWindow,
    },
  );
  const gradedModeHref = toggleHref(
    slug,
    selectedPrinting?.id ?? null,
    debugEnabled,
    returnTo,
    {
      mode: "GRADED",
      provider: activeProvider,
      bucket: activeBucket,
      marketWindow: activeMarketWindow,
    },
  );

  const rawSourceJtcg = rawSnap.data?.justtcg_price ?? null;
  const rawSourceScrydex = rawSnap.data?.scrydex_price ?? rawSnap.data?.pokemontcg_price ?? null;
  let rawSourceJtcgTs: string | null = null;
  let rawSourceScrydexTs: string | null = null;
  for (const row of rawProviderMetricRows) {
    const provider = normalizeRawProviderName(row.provider);
    const ts = row.provider_as_of_ts;
    if (!provider || !ts) continue;
    if (provider === "JUSTTCG" && (!rawSourceJtcgTs || ts > rawSourceJtcgTs)) rawSourceJtcgTs = ts;
    if (provider === "SCRYDEX" && (!rawSourceScrydexTs || ts > rawSourceScrydexTs)) rawSourceScrydexTs = ts;
  }
  for (const row of rawProviderHistoryRows) {
    const provider = normalizeRawProviderName(row.provider);
    if (!provider) continue;
    if (provider === "JUSTTCG" && !rawSourceJtcgTs) rawSourceJtcgTs = row.ts;
    if (provider === "SCRYDEX" && !rawSourceScrydexTs) rawSourceScrydexTs = row.ts;
    if (rawSourceJtcgTs && rawSourceScrydexTs) break;
  }
  if (rawSourceJtcg == null) rawSourceJtcgTs = null;
  if (rawSourceScrydex != null && !rawSourceScrydexTs) {
    rawSourceScrydexTs = rawSnap.data?.market_price_as_of ?? rawSourceJtcgTs;
  }
  const rawSourceAsOfJtcg = formatAsOf(rawSourceJtcgTs);
  const rawSourceAsOfScrydex = formatAsOf(rawSourceScrydexTs);
  let rawPointsJtcg7d = 0;
  let rawPointsScrydex7d = 0;
  const referenceTsMs = rawProviderHistoryRows
    .map((row) => new Date(row.ts).getTime())
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => b - a)[0] ?? 0;
  const weekAgoMs = referenceTsMs - (7 * 24 * 60 * 60 * 1000);
  for (const row of rawProviderHistoryRows) {
    const provider = normalizeRawProviderName(row.provider);
    const tsMs = new Date(row.ts).getTime();
    if (!provider || !Number.isFinite(tsMs) || tsMs < weekAgoMs) continue;
    if (provider === "JUSTTCG") rawPointsJtcg7d += 1;
    if (provider === "SCRYDEX") rawPointsScrydex7d += 1;
  }
  const rawPricing = viewMode === "RAW"
    ? resolveRawDisplayPrice({
      justtcg: rawSourceJtcg,
      scrydex: rawSourceScrydex,
      justtcgAsOfTs: rawSourceJtcgTs,
      scrydexAsOfTs: rawSourceScrydexTs,
      justtcgPoints7d: rawPointsJtcg7d,
      scrydexPoints7d: rawPointsScrydex7d,
      fallback: rawSnap.data?.market_price ?? vm?.price_now ?? null,
      parityStatus: rawParityStatus,
    })
    : null;
  const currentRawPrice = viewMode === "RAW"
    ? rawPricing?.marketPrice ?? null
    : null;
  const displayPrimaryPrice = currentRawPrice ?? snapshotData?.median_7d ?? null;
  const primaryPrice = displayPrimaryPrice != null ? formatUsdCompact(displayPrimaryPrice) : null;
  const primaryPriceLabel = currentRawPrice != null
    ? (() => {
      const confidenceSuffix = rawPricing
        ? ` · Confidence ${rawPricing.confidenceScore}%${rawPricing.lowConfidence ? " (low)" : ""} · Mix J${Math.round(rawPricing.sourceMix.justtcgWeight * 100)} / S${Math.round(rawPricing.sourceMix.scrydexWeight * 100)}`
        : "";
      if (rawPricing?.blendPolicy === "SCRYDEX_PRIMARY") return `Current market price (Scrydex primary)${confidenceSuffix}`;
      if (rawPricing?.blendPolicy === "FALLBACK_STALE_OR_OUTLIER") return `Current market price (stale/outlier fallback)${confidenceSuffix}`;
      return `Current market price (single-provider fallback)${confidenceSuffix}`;
    })()
    : `${selectedSnapshotGrade
      ? legacyGradeLabel(selectedSnapshotGrade)
      : activeProvider && activeBucket
        ? `${providerLabel(activeProvider)} ${gradeBucketLabel(activeBucket)}`
        : "Graded market"
    } · 7-day median ask`;

  const priceChangePct = vm?.change_7d_pct ?? null;
  const displayPriceChangePct = typeof priceChangePct === "number" && Number.isFinite(priceChangePct)
    ? priceChangePct
    : 0;
  const priceChangeLabel = vm?.change_7d_pct != null ? "7d" : null;
  const priceChangeColor = displayPriceChangePct !== 0
    ? displayPriceChangePct > 0 ? "#00DC5A" : "#FF3B30"
    : "#6B6B6B";

  // Fair Value + Edge
  const fairValue = snapshotData?.trimmed_median_30d ?? snapshotData?.median_30d ?? null;
  const edgePercent = displayPrimaryPrice != null && fairValue != null && fairValue > 0
    ? ((displayPrimaryPrice - fairValue) / fairValue) * 100
    : null;
  const edgeAbsPct = edgePercent !== null ? Math.abs(edgePercent) : null;
  const edgeFormatted = edgeAbsPct !== null
    ? (edgeAbsPct >= 10 ? edgeAbsPct.toFixed(0) : edgeAbsPct.toFixed(1)) + "%"
    : null;
  const edgeLabel = edgePercent !== null
    ? edgePercent < -1 ? "Buyer's Edge" : edgePercent > 1 ? "Dealer's Edge" : null
    : null;
  const edgeColor = edgePercent !== null
    ? edgePercent < -1 ? "#00DC5A" : edgePercent > 1 ? "#FF3B30" : "#6B6B6B"
    : "#6B6B6B";

  const rarityInfo = selectedPrinting ? rarityColor(selectedPrinting.rarity) : null;
  const canonicalSetHref = setHref(canonical.set_name);
  const selectedGradedReference = selectedSnapshotGrade && selectedSnapshotGrade !== "RAW"
    ? gradeSnapMap[selectedSnapshotGrade]?.median_7d ?? null
    : null;
  const rawReference = gradeSnapMap.RAW?.median_7d ?? null;
  const gradedPremiumPct = selectedGradedReference != null && rawReference != null && rawReference > 0
    ? ((selectedGradedReference - rawReference) / rawReference) * 100
    : null;
  const gradedProviderCards = gradedVariantRefsForActiveBucket.map((entry) => {
    const latestRow = latestGradedPriceByVariantRef.get(entry.variantRef);
    return {
      key: entry.provider,
      label: providerLabel(entry.provider),
      value: latestRow?.price != null ? formatUsdCompact(latestRow.price) : "Forming",
    };
  });
  const trendMetricValue = formatSignalScore(priceChangePct);
  const breakoutMetricValue = snapshotData?.active_listings_7d != null
    ? snapshotData.active_listings_7d <= 4
      ? "Tight Supply"
      : snapshotData.active_listings_7d <= 10
        ? "Building"
        : "Crowded"
    : "Forming";
  const valueMetricValue = edgeLabel && edgeFormatted
    ? `${edgeFormatted} ${edgeLabel}`
    : fairValue != null
      ? `Fair ${formatUsdCompact(fairValue)}`
      : "Forming";

  return (
    <PageShell>
      <CanonicalCardFloatingHero
        imageUrl={selectedPrinting?.image_url ?? null}
        altText={canonical.canonical_name}
      />

      <div id="content" className="content-sheet">
        <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-8 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
          {/* ── Card identity + price ──────────────────────────────────── */}
          <div className="mb-6">
            <h1 className="text-[36px] font-semibold leading-tight tracking-[-0.035em] text-[#F0F0F0] sm:text-[44px]">
              {canonical.canonical_name}
            </h1>
            <p className="mt-1 text-[15px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">
              {subtitleText}
            </p>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {primaryPrice !== null ? (
                  <>
                    <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="text-[46px] font-bold leading-none tracking-[-0.04em] tabular-nums text-[#F0F0F0] sm:text-[56px]">
                      {primaryPrice}
                    </span>
                    <span
                      className="text-[20px] font-bold tabular-nums tracking-[-0.02em] sm:text-[24px]"
                      style={{ color: priceChangeColor }}
                    >
                      {displayPriceChangePct > 0 ? "+" : ""}{Math.abs(displayPriceChangePct) >= 10 ? displayPriceChangePct.toFixed(0) : displayPriceChangePct.toFixed(1)}%
                    </span>
                    </div>
                    {fairValue != null && (
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="text-[15px] text-[#6B6B6B]">
                          Fair Value <span className="font-semibold tabular-nums text-[#999]">{formatUsdCompact(fairValue)}</span>
                        </span>
                        {edgeLabel && edgeFormatted && (
                          <span
                            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-semibold"
                            style={{
                              color: edgeColor,
                              borderColor: edgePercent != null && edgePercent < -1 ? "rgba(0,220,90,0.25)" : edgePercent != null && edgePercent > 1 ? "rgba(255,59,48,0.25)" : "rgba(107,107,107,0.25)",
                              backgroundColor: edgePercent != null && edgePercent < -1 ? "rgba(0,220,90,0.08)" : edgePercent != null && edgePercent > 1 ? "rgba(255,59,48,0.08)" : "transparent",
                            }}
                          >
                            {edgeFormatted} {edgeLabel}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="mt-1 text-[14px] text-[#555]">{primaryPriceLabel}</p>
                    {viewMode === "RAW" && (rawSourceJtcg != null || rawSourceScrydex != null) ? (
                      <div className="mt-1 text-[13px] tabular-nums text-[#7A7A7A]">
                        <p>
                          JustTCG: {rawSourceJtcg != null ? formatUsdCompact(rawSourceJtcg) : "—"}{" "}
                          <span className="text-[#5E5E5E]">Updated: {rawSourceAsOfJtcg ?? "--"}</span>
                        </p>
                        <p>
                          Scrydex: {rawSourceScrydex != null ? formatUsdCompact(rawSourceScrydex) : "—"}{" "}
                          <span className="text-[#5E5E5E]">Updated: {rawSourceAsOfScrydex ?? "--"}</span>
                        </p>
                      </div>
                    ) : null}
                    {viewMode === "RAW" ? (
                      <PokeTraceBetaCard
                        slug={slug}
                        printingId={selectedPrinting?.id ?? null}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="shrink-0">
                <CardModeToggle
                  activeMode={viewMode}
                  rawHref={rawModeHref}
                  gradedHref={gradedModeHref}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {selectedPrinting && selectedPrintingLabel ? (
                  <Pill label={selectedPrintingLabel} tone="metallic" />
                ) : null}
                {rarityInfo && (
                  <span
                    className="inline-flex min-h-8 items-center rounded-full border px-3 text-[14px] font-semibold"
                    style={{ color: rarityInfo.color, borderColor: rarityInfo.borderColor, backgroundColor: rarityInfo.bgColor }}
                  >
                    {rarityInfo.label}
                  </span>
                )}
                {!selectedPrinting || !selectedPrintingLabel ? (
                  <>
                    {canonical.set_name && canonicalSetHref ? (
                      <Link
                        href={canonicalSetHref}
                        className="inline-flex min-h-7 items-center rounded-full border border-[#1E1E1E] bg-white/[0.04] px-3 text-[15px] font-semibold text-[#999]"
                      >
                        {canonical.set_name}
                      </Link>
                    ) : null}
                    {canonical.card_number ? <Pill label={`#${canonical.card_number}`} tone="neutral" /> : null}
                  </>
                ) : null}
              </div>
              {snapshotData?.active_listings_7d != null ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Pill label={marketStatus.label} tone={marketStatus.tone} />
                </div>
              ) : null}
            </div>
          </div>

          {viewMode === "GRADED" && activeProvider && availableProviders.length > 0 ? (
            <div className="mb-6 rounded-[20px] border border-[#1E1E1E] bg-[#101010] px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill label={activeBucket ? `${gradeBucketLabel(activeBucket)} Grade Board` : "Graded Market"} tone="metallic" />
                  <span className="text-[13px] text-[#6B6B6B]">Latest grader prices we actually have</span>
                </div>
                {selectedGradedReference != null ? (
                  <span className="text-[24px] font-bold tracking-[-0.03em] text-[#F0F0F0]">
                    {formatUsdCompact(selectedGradedReference)}
                  </span>
                ) : (
                  <span className="text-[14px] font-semibold text-[#6B6B6B]">Market forming</span>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-4 sm:gap-6">
                {gradedProviderCards.map((item) => (
                  <StatStripItem key={item.key} label={item.label} value={item.value} />
                ))}
                {rawReference != null ? (
                  <StatStripItem label="Raw Ref" value={formatUsdCompact(rawReference)} />
                ) : null}
                {gradedPremiumPct != null ? (
                  <StatStripItem
                    label="Grade Premium"
                    value={`${gradedPremiumPct > 0 ? "+" : ""}${Math.abs(gradedPremiumPct) >= 10 ? gradedPremiumPct.toFixed(0) : gradedPremiumPct.toFixed(1)}%`}
                    tone={gradedPremiumPct >= 0 ? "positive" : "negative"}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

        <PopAlphaScoutPreview
          cardName={canonical.canonical_name}
          marketPrice={displayPrimaryPrice ?? null}
          fairValue={fairValue}
          changePct={priceChangePct}
          changeLabel={priceChangeLabel}
          activeListings7d={snapshotData?.active_listings_7d ?? null}
          summaryText={cardProfile?.summary_long ?? cardProfile?.summary_short ?? null}
          updatedAt={scoutUpdatedAt}
        />

        <section className="mt-6 mb-6 grid gap-2 sm:grid-cols-3">
          <DerivedMetricTile
            label="Trend"
            value={trendMetricValue}
            tone={priceChangePct != null ? (priceChangePct > 0 ? "positive" : priceChangePct < 0 ? "negative" : "neutral") : "neutral"}
          />
          <DerivedMetricTile
            label="Breakout"
            value={breakoutMetricValue}
            tone={snapshotData?.active_listings_7d != null && snapshotData.active_listings_7d <= 4 ? "positive" : "neutral"}
          />
          <DerivedMetricTile
            label="Value"
            value={valueMetricValue}
            tone={edgePercent != null ? (edgePercent < -1 ? "positive" : edgePercent > 1 ? "negative" : "neutral") : "neutral"}
          />
        </section>

        {/* ── Market Summary (enlarged chart) ──────────────────────────────── */}
        <MarketSummaryCard
          canonicalSlug={slug}
          selectedPrintingId={selectedPrinting?.id ?? null}
          selectedWindow={activeMarketWindow}
          variants={rawVariantOptions}
        />

        {/* ── Variant selector ────────────────────────────────────────────── */}
        {viewMode === "GRADED" ? (
        <GroupedSection title="Variant">
          <div className="space-y-4">
            {availableProviders.length > 0 && activeProvider ? (
              <div>
                <p className="mb-2 text-[15px] font-semibold text-[#777]">Grade</p>
                <SegmentedControl
                  items={availableBucketsForProvider.map((gradeBucket) => ({
                    key: gradeBucket,
                    label: gradeBucketLabel(gradeBucket),
                    href: toggleHref(slug, selectedPrinting?.id ?? null, debugEnabled, returnTo, {
                      mode: "GRADED",
                      bucket: gradeBucket,
                      marketWindow: activeMarketWindow,
                    }),
                    active: gradeBucket === activeBucket,
                  }))}
                />
              </div>
            ) : null}
            {availableProviders.length === 0 || !activeProvider ? (
              <div className="rounded-2xl border border-[#1E1E1E] bg-[#0D0D0D] px-4 py-3 text-sm text-[#6B6B6B]">
                No graded market data is available yet for this card.
              </div>
            ) : null}
          </div>
        </GroupedSection>
        ) : null}

        {/* ── Market Pulse ─────────────────────────────────────────────────
            Community sentiment vote — stub data, wire to DB later. */}
        {currentCardPulse ? (
          <MarketPulse
            canonicalSlug={slug}
            cardName={canonical.canonical_name}
            setName={canonical.set_name}
            imageUrl={selectedPrinting?.image_url ?? null}
            changePct={vm?.change_7d_pct ?? null}
            bullishVotes={currentCardPulse.bullishVotes}
            bearishVotes={currentCardPulse.bearishVotes}
            userVote={currentCardPulse.userVote}
            resolvesAt={cardPulseSnapshot.weekEndsAt}
          />
        ) : null}

        <div className="pt-4 sm:pt-5">
          <CardViewTracker
            canonicalSlug={slug}
            initialTotalViews={viewSnapshot.totalViews}
            initialSeries={viewSnapshot.series}
            locked
          />
        </div>

        {/* ── Live eBay Listings ──────────────────────────────────────────── */}
        <CollapsibleSection title="Live eBay Listings" defaultOpen={false} badge={<Pill label="Live" tone="neutral" size="small" />}>
          <EbayListings
            queries={ebayQueries}
            canonicalSlug={slug}
            canonicalName={canonical.canonical_name}
            setName={canonical.set_name}
            cardNumber={canonical.card_number}
            finish={selectedPrinting?.finish ?? null}
            printingId={selectedPrinting?.id ?? null}
            grade={legacyListingsGrade}
          />
        </CollapsibleSection>

        <RelatedCarouselSection
          title="From This Set"
          cards={relatedCarousels.fromSet}
          emptyMessage="No other tracked cards from this set yet."
        />

        <RelatedCarouselSection
          title="From This Pokémon"
          cards={relatedCarousels.fromPokemon}
          emptyMessage="No other tracked cards from this Pokémon yet."
        />
        </div>
      </div>
    </PageShell>
  );
}

function DerivedMetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const toneClass = tone === "positive"
    ? "border-emerald-400/12 bg-emerald-400/[0.04] text-emerald-100"
    : tone === "negative"
      ? "border-red-400/12 bg-red-400/[0.04] text-red-100"
      : "border-white/[0.06] bg-white/[0.03] text-[#F0F0F0]";

  const subToneClass = tone === "positive"
    ? "text-emerald-200/70"
    : tone === "negative"
      ? "text-red-200/70"
      : "text-[#777]";

  return (
    <div className={`rounded-[20px] border px-4 py-3 backdrop-blur-sm ${toneClass}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${subToneClass}`}>
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold tracking-[-0.02em]">
        {value}
      </p>
    </div>
  );
}
