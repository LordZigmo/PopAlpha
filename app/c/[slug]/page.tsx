/**
 * README
 * Primitives: PageShell, NavBar, GroupedSection, GroupCard, StatRow, StatTile, SegmentedControl, Pill, Skeleton.
 * Layout: sticky compact nav → freefloating hero → variant selector → market intelligence →
 *         grade ladder (RAW / PSA 9 / PSA 10 with premiums + TCG reference) → live listings.
 * iOS grouped rules: matte dark surfaces, consistent radii and spacing, restrained separators,
 * and touch targets sized for mobile-first interaction.
 */
import { notFound } from "next/navigation";
import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CardDetailNavBar from "@/components/card-detail-nav-bar";
import EbayListings from "@/components/ebay-listings";
import { GroupCard, GroupedSection, PageShell, Pill, SegmentedControl, StatRow, StatTile } from "@/components/ios-grouped-ui";
import MarketSnapshotTiles from "@/components/market-snapshot-tiles";
import { buildEbayQuery, type GradeSelection, type GradedSource } from "@/lib/ebay-query";
import { buildPrintingPill } from "@/lib/cards/detail";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { buildAssetViewModel } from "@/lib/data/assets";
import {
  getCachedTcgSetPricing,
  resolveTcgProductMatch,
  resolveTcgTrackingSetDetailed,
  type TcgPricingItem,
  type TcgProductResolution,
  type TcgTrackingSetResolution,
} from "@/lib/tcgtracking";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
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
};

type SnapshotRow = {
  active_listings_7d: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
};

type TcgSnapshotDebug = {
  canonical: {
    name: string;
    setName: string | null;
    cardNumber: string | null;
    year: number | null;
    setCode: string | null;
    finish: CardPrintingRow["finish"] | null;
    edition: CardPrintingRow["edition"] | null;
  };
  setResolution: TcgTrackingSetResolution;
  productResolution: TcgProductResolution | null;
  error: string | null;
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
  signals_as_of_ts: string | null;
  history_points_30d: number | null;
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

function printingOptionLabel(printing: CardPrintingRow): string {
  return [finishLabel(printing.finish), printing.edition === "FIRST_EDITION" ? "1st Ed" : null, printing.stamp]
    .filter((value) => Boolean(value))
    .join(" • ");
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
  },
): string {
  const params = new URLSearchParams();
  if (printingId) params.set("printing", printingId);
  const mode = opts?.mode;
  const bucket = opts?.bucket;
  const provider = opts?.provider;
  if (mode && mode !== "RAW") params.set("mode", mode);
  if (provider) params.set("provider", provider);
  if (bucket) params.set("bucket", bucket);
  if (bucket === "G9") params.set("grade", "PSA9");
  else if (bucket === "G10") params.set("grade", "PSA10");
  if (debugEnabled) params.set("debug", "1");
  const backHref = resolveBackHref(returnTo);
  if (backHref !== DEFAULT_BACK_HREF) params.set("returnTo", backHref);
  const qs = params.toString();
  return qs ? `/c/${encodeURIComponent(slug)}?${qs}` : `/c/${encodeURIComponent(slug)}`;
}

function scarcitySignal(active7d: number | null): { label: string; tone: "positive" | "warning" | "neutral" } {
  if (active7d === null || active7d === undefined) return { label: "Forming", tone: "neutral" };
  if (active7d <= 2) return { label: "High", tone: "positive" };
  if (active7d <= 6) return { label: "Moderate", tone: "warning" };
  return { label: "Low", tone: "neutral" };
}

function liquiditySignal(active7d: number | null): { label: string; tone: "positive" | "warning" | "neutral" } {
  if (active7d === null || active7d === undefined) return { label: "Forming", tone: "neutral" };
  if (active7d <= 2) return { label: "Thin", tone: "warning" };
  if (active7d <= 6) return { label: "Moderate", tone: "neutral" };
  return { label: "Active", tone: "positive" };
}

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function gradePremium(
  rawPrice: number | null,
  gradedPrice: number | null
): { text: string | null; tone: "positive" | "neutral" } {
  if (!rawPrice || !gradedPrice || rawPrice <= 0) return { text: null, tone: "neutral" };
  const pct = ((gradedPrice - rawPrice) / rawPrice) * 100;
  const sign = pct >= 0 ? "+" : "";
  return {
    text: `${sign}${Math.round(pct)}% vs Raw`,
    tone: pct > 10 ? "positive" : "neutral",
  };
}

async function getTcgSnapshot(
  canonical: CanonicalCardRow,
  selectedPrinting: CardPrintingRow | null
): Promise<{ item: TcgPricingItem | null; setName: string | null; updatedAt: string | null; debug: TcgSnapshotDebug }> {
  const cat = selectedPrinting?.language?.toUpperCase() === "JP" ? 85 : 3;
  const defaultSetResolution: TcgTrackingSetResolution = {
    queryUsed: selectedPrinting?.set_code ?? canonical.set_name ?? null,
    normalizedQuery: null,
    candidates: [],
    chosen: null,
  };
  const defaultDebug: TcgSnapshotDebug = {
    canonical: {
      name: canonical.canonical_name,
      setName: canonical.set_name,
      cardNumber: canonical.card_number,
      year: canonical.year,
      setCode: selectedPrinting?.set_code ?? null,
      finish: selectedPrinting?.finish ?? null,
      edition: selectedPrinting?.edition ?? null,
    },
    setResolution: defaultSetResolution,
    productResolution: null,
    error: null,
  };

  try {
    const setResolution = await resolveTcgTrackingSetDetailed({
      cat,
      setCode: selectedPrinting?.set_code ?? null,
      setName: canonical.set_name,
    });
    defaultDebug.setResolution = setResolution;

    if (!setResolution.chosen) {
      return { item: null, setName: canonical.set_name, updatedAt: null, debug: defaultDebug };
    }

    const payload = await getCachedTcgSetPricing({
      cat,
      setId: setResolution.chosen.id,
      limit: 250,
    });
    const productResolution = resolveTcgProductMatch({
      items: payload.items,
      canonicalName: canonical.canonical_name,
      canonicalCardNumber: canonical.card_number,
    });
    defaultDebug.productResolution = productResolution;

    const matched = payload.items.find((item) => item.productId === productResolution.chosen?.productId) ?? null;

    return {
      item: matched,
      setName: payload.setName ?? setResolution.chosen.name ?? canonical.set_name,
      updatedAt: matched?.updatedAt ?? payload.updatedAt ?? null,
      debug: defaultDebug,
    };
  } catch (error) {
    defaultDebug.error = error instanceof Error ? error.message : String(error);
    return { item: null, setName: canonical.set_name, updatedAt: null, debug: defaultDebug };
  }
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
    debug?: string;
    returnTo?: string;
  }>;
}) {
  const { slug } = await params;
  const { printing, grade, mode, provider, bucket, debug, returnTo } = await searchParams;
  const supabase = getServerSupabaseClient();
  const debugEnabled = debug === "1";
  const backHref = resolveBackHref(returnTo);

  const { data: canonical } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, year, card_number")
    .eq("slug", slug)
    .maybeSingle<CanonicalCardRow>();

  if (!canonical) notFound();

  const { data: printingsData } = await supabase
    .from("card_printings")
    .select("id, language, set_code, finish, finish_detail, edition, stamp, image_url")
    .eq("canonical_slug", slug);

  const printings = ((printingsData ?? []) as CardPrintingRow[]).sort(sortPrintings);
  const viewMode = selectedViewMode(mode, grade);
  const selectedPrinting = printings.find((row) => row.id === printing) ?? printings[0] ?? null;
  const selectedPrintingLabel = selectedPrinting ? printingOptionLabel(selectedPrinting) : "Unknown printing";
  const variantPills = printings.map((row) => ({
    printing: row,
    pill: buildPrintingPill({
      id: row.id,
      canonical_slug: slug,
      finish: row.finish,
      finish_detail: row.finish_detail,
      edition: row.edition,
      stamp: row.stamp,
      image_url: row.image_url,
    }),
  }));

  const { data: gradedAvailabilityData } = selectedPrinting
    ? await supabase
        .from("variant_metrics")
        .select("provider, grade, provider_as_of_ts, signals_as_of_ts, history_points_30d")
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
      return row.signals_as_of_ts !== null
        || row.provider_as_of_ts !== null
        || (row.history_points_30d ?? 0) >= 5;
    });

  const availableProviders = GRADED_SOURCES.filter((source) =>
    gradedAvailability.some((row) => row.provider === source)
  );
  const activeProvider = selectedProvider(provider)
    ?? (availableProviders.includes("PSA") ? "PSA" : availableProviders[0] ?? "PSA");

  const availableBucketsForProvider = GRADE_BUCKETS.filter((gradeBucket) =>
    gradedAvailability.some((row) => row.provider === activeProvider && row.grade === gradeBucket)
  );
  const activeBucket = selectedBucket(bucket, grade)
    ?? (availableBucketsForProvider.includes("G9")
      ? "G9"
      : availableBucketsForProvider.includes("G10")
        ? "G10"
        : availableBucketsForProvider[0] ?? "G9");

  const selectedSnapshotGrade = snapshotGradeForSelection(viewMode, activeBucket);
  const queryGradeSelection: GradeSelection = viewMode === "RAW" ? "RAW" : activeBucket;
  const legacyListingsGrade: "RAW" | "PSA9" | "PSA10" = selectedSnapshotGrade ?? "RAW";

  // Fetch all three grade snapshots + view model in parallel.
  // card_metrics rows are keyed by (canonical_slug, printing_id, grade).
  // For singles: printing_id = selected printing UUID. For sealed / no printing: printing_id IS NULL.
  const printingIdForQuery = selectedPrinting?.id ?? null;
  const [[rawSnap, psa9Snap, psa10Snap], vm] = await Promise.all([
    Promise.all(
      (["RAW", "PSA9", "PSA10"] as const).map((g) => {
        const q = supabase
          .from("card_metrics")
          .select("active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d")
          .eq("canonical_slug", slug)
          .eq("grade", g);
        return (printingIdForQuery != null
          ? q.eq("printing_id", printingIdForQuery)
          : q.is("printing_id", null)
        ).maybeSingle<SnapshotRow>();
      })
    ),
    buildAssetViewModel(slug),
  ]);

  const gradeSnapMap = {
    RAW: rawSnap.data,
    PSA9: psa9Snap.data,
    PSA10: psa10Snap.data,
  } as const;

  const snapshotData = selectedSnapshotGrade ? gradeSnapMap[selectedSnapshotGrade] : null;

  const snapshot = snapshotData
    ? {
        ok: true,
        active7d: snapshotData.active_listings_7d ?? 0,
        median7d: snapshotData.median_7d,
        median30d: snapshotData.median_30d,
        trimmedMedian30d: snapshotData.trimmed_median_30d,
        low30d: snapshotData.low_30d,
        high30d: snapshotData.high_30d,
      }
    : null;

  const scarcity = scarcitySignal(snapshotData?.active_listings_7d ?? null);
  const liquidity = liquiditySignal(snapshotData?.active_listings_7d ?? null);
  const ebayQuery = buildEbayQuery({
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
  const tcgSnapshot = await getTcgSnapshot(canonical, selectedPrinting);

  const subtitleText = [
    canonical.set_name,
    canonical.card_number ? `#${canonical.card_number}` : null,
    canonical.year ? String(canonical.year) : null,
  ]
    .filter(Boolean)
    .join(" • ");

  const primaryPrice = snapshotData?.median_7d != null ? formatUsdCompact(snapshotData.median_7d) : null;
  const primaryPriceLabel = `${selectedSnapshotGrade ? legacyGradeLabel(selectedSnapshotGrade) : `${providerLabel(activeProvider)} ${gradeBucketLabel(activeBucket)}`} · 7-day median ask`;

  // Grade Ladder premium calculations.
  const rawMedian7d = gradeSnapMap.RAW?.median_7d ?? null;
  const psa9Premium = gradePremium(rawMedian7d, gradeSnapMap.PSA9?.median_7d ?? null);
  const psa10Premium = gradePremium(rawMedian7d, gradeSnapMap.PSA10?.median_7d ?? null);

  return (
    <PageShell>
      <CardDetailNavBar title="" backHref={backHref} />

      <CanonicalCardFloatingHero
        imageUrl={selectedPrinting?.image_url ?? null}
        title={canonical.canonical_name}
        subtitle={subtitleText}
        price={primaryPrice}
        priceLabel={primaryPriceLabel}
        signals={
          <>
            {snapshotData?.active_listings_7d != null && <Pill label={`Scarcity ${scarcity.label}`} tone={scarcity.tone} />}
            {snapshotData?.active_listings_7d != null && <Pill label={`Liquidity ${liquidity.label}`} tone={liquidity.tone} />}
            <Pill label={selectedPrintingLabel} tone={selectedPrinting ? "neutral" : "warning"} />
          </>
        }
      />

      <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-4 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
        {/* ── Variant selector ──────────────────────────────────────────────────
            Near the top so users can pivot grade or printing before
            reading the market signal data below. */}
        <GroupedSection title="Variant">
          <GroupCard>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Mode</p>
                <SegmentedControl
                  items={VIEW_MODES.map((option) => ({
                    key: option,
                    label: option,
                    href: toggleHref(
                      slug,
                      selectedPrinting?.id ?? null,
                      debugEnabled,
                      returnTo,
                      {
                        mode: option,
                        provider: option === "GRADED" ? activeProvider : null,
                        bucket: option === "GRADED" ? activeBucket : null,
                      },
                    ),
                    active: option === viewMode,
                  }))}
                />
              </div>
              {viewMode === "RAW" && variantPills.length > 0 ? (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Variant</p>
                  <SegmentedControl
                    wrap
                    items={variantPills.map(({ printing: variantPrinting, pill }) => ({
                      key: pill.pillKey,
                      label: pill.pillLabel,
                      href: toggleHref(slug, variantPrinting.id, debugEnabled, returnTo, { mode: "RAW" }),
                      active: selectedPrinting?.id === variantPrinting.id,
                    }))}
                  />
                </div>
              ) : null}
              {viewMode === "GRADED" ? (
                <>
                  <div>
                    <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Source</p>
                    <SegmentedControl
                      wrap
                      items={GRADED_SOURCES.map((source) => {
                        const providerHasRows = availableProviders.includes(source);
                        const fallbackBucketForSource = GRADE_BUCKETS.find((gradeBucket) =>
                          gradedAvailability.some((row) => row.provider === source && row.grade === gradeBucket)
                        ) ?? activeBucket;

                        return {
                          key: source,
                          label: providerLabel(source),
                          href: toggleHref(slug, selectedPrinting?.id ?? null, debugEnabled, returnTo, {
                            mode: "GRADED",
                            provider: source,
                            bucket: source === activeProvider ? activeBucket : fallbackBucketForSource,
                          }),
                          active: source === activeProvider,
                          disabled: !providerHasRows,
                        };
                      })}
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Grade</p>
                    <SegmentedControl
                      items={GRADE_BUCKETS.map((gradeBucket) => ({
                        key: gradeBucket,
                        label: gradeBucketLabel(gradeBucket),
                        href: toggleHref(slug, selectedPrinting?.id ?? null, debugEnabled, returnTo, {
                          mode: "GRADED",
                          provider: activeProvider,
                          bucket: gradeBucket,
                        }),
                        active: gradeBucket === activeBucket,
                        disabled: !availableBucketsForProvider.includes(gradeBucket),
                      }))}
                    />
                  </div>
                </>
              ) : null}
            </div>
          </GroupCard>
        </GroupedSection>

        {/* ── Market Intelligence ───────────────────────────────────────────────
            Primary signal tiles: 7D median, 7D change, trimmed 30D median,
            plus depth rows for velocity and spread. */}
        <MarketSnapshotTiles
          slug={slug}
          printingId={selectedPrinting?.id ?? null}
          grade={selectedSnapshotGrade ?? activeBucket}
          initialData={snapshot}
        />

        {/* ── PopAlpha Signals ──────────────────────────────────────────────────
            Derived analytics. Shows tiles when signal data exists, or a
            "not enough data" notice when a variant is known but unscored. */}
        {vm?.selectedVariantRef != null && (
          <GroupedSection
            title="PopAlpha Signals"
            description="Computed nightly from price momentum, volatility, and activity data."
          >
            {vm.signals ? (
              <GroupCard>
                <div className="grid grid-cols-3 gap-3">
                  {vm.signals.trend && (
                    <StatTile
                      label="Trend"
                      value={vm.signals.trend.label}
                      detail={`Score ${vm.signals.trend.score.toFixed(0)}/100`}
                      tone={
                        vm.signals.trend.score >= 60 ? "positive"
                          : vm.signals.trend.score <= 40 ? "warning"
                          : "neutral"
                      }
                    />
                  )}
                  {vm.signals.breakout && (
                    <StatTile
                      label="Breakout"
                      value={vm.signals.breakout.label}
                      detail={`Score ${vm.signals.breakout.score.toFixed(0)}/100`}
                      tone={
                        vm.signals.breakout.score >= 65 ? "positive"
                          : vm.signals.breakout.score <= 35 ? "warning"
                          : "neutral"
                      }
                    />
                  )}
                  {vm.signals.value && (
                    <StatTile
                      label="Value Zone"
                      value={vm.signals.value.label}
                      detail={`Score ${vm.signals.value.score.toFixed(0)}/100`}
                      tone={vm.signals.value.score >= 60 ? "positive" : "neutral"}
                    />
                  )}
                </div>
              </GroupCard>
            ) : (
              <GroupCard>
                <p className="text-[14px] text-[#8c94a3]">
                  Not enough recent activity to score this variant.
                </p>
              </GroupCard>
            )}
          </GroupedSection>
        )}

        {/* ── Grade Ladder ──────────────────────────────────────────────────────
            Shows RAW / PSA 9 / PSA 10 side-by-side so collectors instantly
            see the grading premium. TCGPlayer reference price anchors raw value. */}
        <GroupedSection title="Grade Ladder" description="7-day median ask across condition tiers.">
          <GroupCard>
            <div className="grid grid-cols-3 gap-3">
              <StatTile
                label="Raw"
                value={formatUsdCompact(gradeSnapMap.RAW?.median_7d)}
                detail={viewMode === "RAW" ? "Current view" : undefined}
              />
              <StatTile
                label="PSA 9"
                value={formatUsdCompact(gradeSnapMap.PSA9?.median_7d)}
                detail={psa9Premium.text}
                tone={psa9Premium.tone}
              />
              <StatTile
                label="PSA 10"
                value={formatUsdCompact(gradeSnapMap.PSA10?.median_7d)}
                detail={psa10Premium.text}
                tone={psa10Premium.tone}
              />
            </div>
            {tcgSnapshot.item?.marketPrice != null && (
              <div className="mt-4 border-t border-white/[0.06] pt-4">
                <StatRow
                  label="TCGPlayer Market"
                  value={formatUsdCompact(tcgSnapshot.item.marketPrice)}
                  meta={
                    tcgSnapshot.updatedAt
                      ? `Updated ${new Date(tcgSnapshot.updatedAt).toLocaleDateString()}`
                      : "Raw reference price"
                  }
                />
              </div>
            )}
          </GroupCard>
        </GroupedSection>

        {/* ── Debug (gate: ?debug=1) ─────────────────────────────────────────── */}
        {debugEnabled ? (
          <GroupedSection title="TCG Match Debug" description="Resolution details for set and product matching.">
            <div className="grid gap-3 lg:grid-cols-3">
              <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Canonical</p>}>
                <div className="divide-y divide-white/[0.06]">
                  <StatRow label="Name" value={tcgSnapshot.debug.canonical.name} />
                  <StatRow label="Set" value={tcgSnapshot.debug.canonical.setName ?? "Unknown"} />
                  <StatRow label="Number" value={tcgSnapshot.debug.canonical.cardNumber ?? "Unknown"} />
                  <StatRow label="Year" value={tcgSnapshot.debug.canonical.year ?? "Unknown"} />
                  <StatRow
                    label="Printing"
                    value={`${tcgSnapshot.debug.canonical.finish ?? "Unknown"} / ${tcgSnapshot.debug.canonical.edition ?? "Unknown"}`}
                  />
                </div>
              </GroupCard>

              <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Set Resolution</p>}>
                <div className="divide-y divide-white/[0.06]">
                  <StatRow label="Query used" value={tcgSnapshot.debug.setResolution.queryUsed ?? "None"} />
                  <StatRow label="Normalized" value={tcgSnapshot.debug.setResolution.normalizedQuery ?? "None"} />
                  <StatRow
                    label="Chosen"
                    value={
                      tcgSnapshot.debug.setResolution.chosen
                        ? `${tcgSnapshot.debug.setResolution.chosen.id} • score ${tcgSnapshot.debug.setResolution.chosen.score}`
                        : "No set match"
                    }
                  />
                </div>
                <div className="mt-4 space-y-2">
                  {tcgSnapshot.debug.setResolution.candidates.length === 0 ? (
                    <Pill label="No candidate sets returned" tone="warning" />
                  ) : (
                    tcgSnapshot.debug.setResolution.candidates.map((candidate) => (
                      <GroupCard key={candidate.id} inset>
                        <p className="text-[13px] font-semibold text-[#f5f7fb]">{candidate.name ?? "Unnamed"}</p>
                        <p className="mt-1 text-[12px] text-[#8c94a3]">
                          {candidate.id} • Code {candidate.code ?? "n/a"} • Year {candidate.year ?? "n/a"} • Score{" "}
                          {candidate.score}
                        </p>
                      </GroupCard>
                    ))
                  )}
                </div>
              </GroupCard>

              <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Product Resolution</p>}>
                <div className="divide-y divide-white/[0.06]">
                  <StatRow label="Products in set" value={tcgSnapshot.debug.productResolution?.productsInSet ?? 0} />
                  <StatRow
                    label="Chosen"
                    value={
                      tcgSnapshot.debug.productResolution?.chosen
                        ? `${tcgSnapshot.debug.productResolution.chosen.productId}`
                        : "No product match"
                    }
                  />
                  <StatRow
                    label="Reason"
                    value={tcgSnapshot.debug.productResolution?.chosenReason ?? "No reason recorded"}
                  />
                </div>
                <div className="mt-4 space-y-2">
                  {tcgSnapshot.debug.productResolution?.warning ? (
                    <Pill label={tcgSnapshot.debug.productResolution.warning} tone="warning" />
                  ) : null}
                  {tcgSnapshot.debug.error ? <Pill label={tcgSnapshot.debug.error} tone="negative" /> : null}
                  {tcgSnapshot.debug.productResolution?.topCandidates.length ? (
                    tcgSnapshot.debug.productResolution.topCandidates.map((candidate) => (
                      <GroupCard key={candidate.productId} inset>
                        <p className="text-[13px] font-semibold text-[#f5f7fb]">{candidate.name ?? "Unnamed"}</p>
                        <p className="mt-1 text-[12px] text-[#8c94a3]">
                          #{candidate.number ?? "n/a"} • {candidate.rarity ?? "No rarity"} • Score {candidate.score}
                        </p>
                        <p className="mt-2 text-[12px] text-[#c8ccd7]">Market {formatUsdCompact(candidate.marketPrice)}</p>
                      </GroupCard>
                    ))
                  ) : (
                    <Pill label="No scored product candidates" tone="warning" />
                  )}
                </div>
              </GroupCard>
            </div>
          </GroupedSection>
        ) : null}

        {/* ── Live Market Listings ──────────────────────────────────────────────
            Raw eBay evidence. Also triggers /api/market/observe to record
            prices into listing_observations for future signal aggregation. */}
        <EbayListings
          query={ebayQuery}
          canonicalSlug={slug}
          printingId={selectedPrinting?.id ?? null}
          grade={legacyListingsGrade}
        />
      </div>
    </PageShell>
  );
}
