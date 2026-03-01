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
import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CollapsibleSection from "@/components/collapsible-section";
import EbayListings from "@/components/ebay-listings";
import { GroupedSection, PageShell, Pill, SegmentedControl } from "@/components/ios-grouped-ui";
import MarketPulse from "@/components/market-pulse";
import MarketSummaryCard from "@/components/market-summary-card";
import PriceTickerStrip from "@/components/price-ticker-strip";
import SignalGauge from "@/components/signal-gauge";
import { buildEbayQuery, type GradeSelection, type GradedSource } from "@/lib/ebay-query";
import { buildPrintingPill } from "@/lib/cards/detail";
import { buildRawVariantRef } from "@/lib/identity/variant-ref";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { buildAssetViewModel } from "@/lib/data/assets";

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

function shouldWrapVariantSegments(count: number): boolean {
  return count > 4;
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

function signalConfidenceLabel(points30d: number | null): { label: string; tone: "positive" | "warning" | "negative" | "neutral" } {
  if (points30d === null || !Number.isFinite(points30d)) return { label: "--", tone: "neutral" };
  if (points30d >= 80) return { label: "High", tone: "positive" };
  if (points30d >= 30) return { label: "Medium", tone: "warning" };
  return { label: "Low", tone: "negative" };
}

function formatSignalsUpdated(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
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
  const supabase = getServerSupabaseClient();
  const debugEnabled = debug === "1";
  const backHref = resolveBackHref(returnTo);
  const activeMarketWindow = selectedMarketWindow(marketWindow);

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
  const selectedPrintingLabel = selectedPrinting ? printingOptionLabel(selectedPrinting) : null;
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
  const rawVariantRef = selectedPrinting ? buildRawVariantRef(selectedPrinting.id) : null;

  const subtitleText = [
    canonical.set_name,
    canonical.card_number ? `#${canonical.card_number}` : null,
    canonical.year ? String(canonical.year) : null,
  ]
    .filter(Boolean)
    .join(" • ");

  const primaryPrice = snapshotData?.median_7d != null ? formatUsdCompact(snapshotData.median_7d) : null;
  const primaryPriceLabel = `${selectedSnapshotGrade ? legacyGradeLabel(selectedSnapshotGrade) : `${providerLabel(activeProvider)} ${gradeBucketLabel(activeBucket)}`} · 7-day median ask`;
  const canonicalSetHref = setHref(canonical.set_name);

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
            <p className="text-[15px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">
              {subtitleText}
            </p>
            <h1 className="mt-1 text-[36px] font-semibold leading-tight tracking-[-0.035em] text-[#F0F0F0] sm:text-[44px]">
              {canonical.canonical_name}
            </h1>
            {primaryPrice !== null && (
              <div className="mt-3 flex flex-wrap items-baseline gap-2.5">
                <span className="text-[46px] font-bold leading-none tracking-[-0.04em] tabular-nums text-[#F0F0F0] sm:text-[56px]">
                  {primaryPrice}
                </span>
                <span className="text-[16px] leading-tight text-[#6B6B6B]">
                  {primaryPriceLabel}
                </span>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {snapshotData?.active_listings_7d != null && <Pill label={`Scarcity ${scarcity.label}`} tone={scarcity.tone} />}
              {snapshotData?.active_listings_7d != null && <Pill label={`Liquidity ${liquidity.label}`} tone={liquidity.tone} />}
              {selectedPrinting && selectedPrintingLabel ? (
                <Pill label={selectedPrintingLabel} tone="metallic" />
              ) : (
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
              )}
            </div>
          </div>

        {/* ── Signal Gauges ──────────────────────────────────────────────────── */}
        {vm?.signals && (vm.signals.trend || vm.signals.breakout || vm.signals.value) && (
          <div className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
            <SignalGauge
              label="Trend"
              score={vm.signals.trend?.score ?? null}
              displayLabel={vm.signals.trend?.label}
            />
            <SignalGauge
              label="Breakout"
              score={vm.signals.breakout?.score ?? null}
              displayLabel={vm.signals.breakout?.label}
            />
            <SignalGauge
              label="Value"
              score={vm.signals.value?.score ?? null}
              displayLabel={vm.signals.value?.label}
            />
          </div>
        )}

        {/* ── Market Summary (enlarged chart) ──────────────────────────────── */}
        <MarketSummaryCard
          canonicalSlug={slug}
          printingId={selectedPrinting?.id ?? null}
          variantRef={rawVariantRef}
          selectedWindow={activeMarketWindow}
        />

        {/* ── Signal meta strip ────────────────────────────────────────────── */}
        {(vm?.signals_history_points_30d != null || vm?.signals_as_of_ts) && (
          <div className="mt-4 flex flex-wrap gap-4 rounded-2xl border border-[#1E1E1E] bg-[#111111] px-4 py-3 sm:gap-6 sm:px-5 sm:py-3.5">
            {[
              {
                label: "Confidence",
                value: signalConfidenceLabel(vm?.signals_history_points_30d ?? null).label,
                color: { positive: "#00DC5A", negative: "#FF3B30", warning: "#FFD60A", neutral: "#F0F0F0" }[signalConfidenceLabel(vm?.signals_history_points_30d ?? null).tone],
              },
              {
                label: "Last Computed",
                value: formatSignalsUpdated(vm?.signals_as_of_ts ?? null),
                color: "#F0F0F0",
              },
              {
                label: "Data Points",
                value: vm?.signals_history_points_30d != null ? String(vm.signals_history_points_30d) : "--",
                color: "#F0F0F0",
              },
            ].map((item) => (
              <div key={item.label} className="flex-1 min-w-[70px]">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B] sm:text-[13px]">{item.label}</p>
                <p className="mt-1 text-[17px] font-bold tabular-nums tracking-[-0.02em] sm:text-[20px]" style={{ color: item.color }}>{item.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Variant selector ────────────────────────────────────────────── */}
        <GroupedSection title="Variant">
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[15px] font-semibold text-[#777]">Mode</p>
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
                      marketWindow: activeMarketWindow,
                    },
                  ),
                  active: option === viewMode,
                }))}
              />
            </div>
            {viewMode === "RAW" && variantPills.length > 0 ? (
                <div>
                  <p className="mb-2 text-[15px] font-semibold text-[#777]">Variant</p>
                  <SegmentedControl
                    wrap={shouldWrapVariantSegments(variantPills.length)}
                    items={variantPills.map(({ printing: variantPrinting, pill }) => ({
                      key: pill.pillKey,
                      label: rawVariantSegmentLabel(variantPrinting, printings),
                      href: toggleHref(slug, variantPrinting.id, debugEnabled, returnTo, { mode: "RAW", marketWindow: activeMarketWindow }),
                      active: selectedPrinting?.id === variantPrinting.id,
                    }))}
                  />
              </div>
            ) : null}
            {viewMode === "GRADED" ? (
              <>
                <div>
                  <p className="mb-2 text-[15px] font-semibold text-[#777]">Source</p>
                  <SegmentedControl
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
                          marketWindow: activeMarketWindow,
                        }),
                        active: source === activeProvider,
                        disabled: !providerHasRows,
                      };
                    })}
                  />
                </div>
                <div>
                  <p className="mb-2 text-[15px] font-semibold text-[#777]">Grade</p>
                  <SegmentedControl
                    items={GRADE_BUCKETS.map((gradeBucket) => ({
                      key: gradeBucket,
                      label: gradeBucketLabel(gradeBucket),
                      href: toggleHref(slug, selectedPrinting?.id ?? null, debugEnabled, returnTo, {
                        mode: "GRADED",
                        provider: activeProvider,
                        bucket: gradeBucket,
                        marketWindow: activeMarketWindow,
                      }),
                      active: gradeBucket === activeBucket,
                      disabled: !availableBucketsForProvider.includes(gradeBucket),
                    }))}
                  />
                </div>
              </>
            ) : null}
          </div>
        </GroupedSection>

        {/* ── Market Pulse ─────────────────────────────────────────────────
            Community sentiment vote — stub data, wire to DB later. */}
        <MarketPulse
          bullishVotes={0}
          bearishVotes={0}
          userVote={null}
          resolvesAt={Date.now() + 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000}
        />

        {/* ── Live eBay Listings ──────────────────────────────────────────── */}
        <CollapsibleSection title="Live eBay Listings" defaultOpen={false} badge={<Pill label="Live" tone="neutral" size="small" />}>
          <EbayListings
            query={ebayQuery}
            canonicalSlug={slug}
            printingId={selectedPrinting?.id ?? null}
            grade={legacyListingsGrade}
          />
        </CollapsibleSection>
        </div>
      </div>
    </PageShell>
  );
}
