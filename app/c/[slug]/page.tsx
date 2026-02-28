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
import { buildEbayQuery, type GradeSelection } from "@/lib/ebay-query";
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

const GRADE_OPTIONS: GradeSelection[] = ["RAW", "PSA9", "PSA10"];

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

function editionLabel(edition: CardPrintingRow["edition"]): string {
  const map: Record<CardPrintingRow["edition"], string> = {
    UNLIMITED: "Unlimited",
    FIRST_EDITION: "1st Edition",
    UNKNOWN: "Unknown Edition",
  };
  return map[edition];
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

function gradeLabel(grade: GradeSelection): string {
  if (grade === "PSA9") return "PSA 9";
  if (grade === "PSA10") return "PSA 10";
  return "Raw";
}

function printingOptionLabel(printing: CardPrintingRow): string {
  return [finishLabel(printing.finish), printing.edition === "FIRST_EDITION" ? "1st Ed" : null, printing.stamp]
    .filter((value) => Boolean(value))
    .join(" • ");
}

function resolvePrintingSelection(
  printings: CardPrintingRow[],
  selectedPrinting: CardPrintingRow | null,
  overrides: Partial<Pick<CardPrintingRow, "finish" | "edition" | "stamp">>
): CardPrintingRow | null {
  if (printings.length === 0) return null;

  const desired = {
    finish: overrides.finish ?? selectedPrinting?.finish ?? null,
    edition: overrides.edition ?? selectedPrinting?.edition ?? null,
    stamp: overrides.stamp ?? selectedPrinting?.stamp ?? null,
  };

  const exact = printings.find(
    (printing) =>
      (desired.finish === null || printing.finish === desired.finish) &&
      (desired.edition === null || printing.edition === desired.edition) &&
      (desired.stamp === null || printing.stamp === desired.stamp)
  );
  if (exact) return exact;

  const byFinishEdition = printings.find(
    (printing) =>
      (desired.finish === null || printing.finish === desired.finish) &&
      (desired.edition === null || printing.edition === desired.edition)
  );
  if (byFinishEdition) return byFinishEdition;

  const byFinish = printings.find((printing) => desired.finish === null || printing.finish === desired.finish);
  if (byFinish) return byFinish;

  const byEdition = printings.find((printing) => desired.edition === null || printing.edition === desired.edition);
  if (byEdition) return byEdition;

  return printings[0];
}

function toggleHref(slug: string, printingId: string | null, grade: GradeSelection, debugEnabled: boolean): string {
  const params = new URLSearchParams();
  if (printingId) params.set("printing", printingId);
  if (grade !== "RAW") params.set("grade", grade);
  if (debugEnabled) params.set("debug", "1");
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

/** Formats a numeric signal value for display, rounding to 2 dp. */
function formatSignal(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
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
  searchParams: Promise<{ printing?: string; grade?: string; debug?: string }>;
}) {
  const { slug } = await params;
  const { printing, grade, debug } = await searchParams;
  const supabase = getServerSupabaseClient();
  const debugEnabled = debug === "1";

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
  const gradeSelection = selectedGrade(grade);
  const selectedPrinting = printings.find((row) => row.id === printing) ?? printings[0] ?? null;
  const selectedPrintingLabel = selectedPrinting ? printingOptionLabel(selectedPrinting) : "Unknown printing";
  const finishOptions = Array.from(new Set(printings.map((row) => row.finish)));
  const editionOptions = Array.from(new Set(printings.map((row) => row.edition)));
  const stampOptions = Array.from(
    new Set(printings.map((row) => row.stamp).filter((value): value is string => Boolean(value)))
  );

  // Fetch all three grade snapshots + view model in parallel.
  const printingIdForQuery = selectedPrinting?.id ?? null;
  const [[rawSnap, psa9Snap, psa10Snap], vm] = await Promise.all([
    Promise.all(
      (["RAW", "PSA9", "PSA10"] as const).map((g) =>
        supabase
          .from("card_metrics")
          .select("active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d")
          .eq("canonical_slug", slug)
          .eq("grade", g)
          .is("printing_id", printingIdForQuery)
          .maybeSingle<SnapshotRow>()
      )
    ),
    buildAssetViewModel(slug),
  ]);

  const gradeSnapMap = {
    RAW: rawSnap.data,
    PSA9: psa9Snap.data,
    PSA10: psa10Snap.data,
  } as const;

  const snapshotData = gradeSnapMap[gradeSelection];

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
    grade: gradeSelection,
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
  const primaryPriceLabel = `${gradeLabel(gradeSelection)} · 7-day median ask`;

  // Grade Ladder premium calculations.
  const rawMedian7d = gradeSnapMap.RAW?.median_7d ?? null;
  const psa9Premium = gradePremium(rawMedian7d, gradeSnapMap.PSA9?.median_7d ?? null);
  const psa10Premium = gradePremium(rawMedian7d, gradeSnapMap.PSA10?.median_7d ?? null);

  return (
    <PageShell>
      <CardDetailNavBar title={canonical.canonical_name} subtitle={selectedPrintingLabel} />

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
              {finishOptions.length > 1 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Finish</p>
                  <SegmentedControl
                    wrap
                    items={finishOptions.map((finish) => {
                      const nextPrinting = resolvePrintingSelection(printings, selectedPrinting, { finish });
                      return {
                        key: finish,
                        label: finishLabel(finish),
                        href: toggleHref(slug, nextPrinting?.id ?? null, gradeSelection, debugEnabled),
                        active: selectedPrinting?.finish === finish,
                      };
                    })}
                  />
                </div>
              )}
              {editionOptions.length > 1 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Edition</p>
                  <SegmentedControl
                    wrap
                    items={editionOptions.map((edition) => {
                      const nextPrinting = resolvePrintingSelection(printings, selectedPrinting, { edition });
                      return {
                        key: edition,
                        label: editionLabel(edition),
                        href: toggleHref(slug, nextPrinting?.id ?? null, gradeSelection, debugEnabled),
                        active: selectedPrinting?.edition === edition,
                      };
                    })}
                  />
                </div>
              )}
              {stampOptions.length > 0 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Stamp</p>
                  <SegmentedControl
                    wrap
                    items={stampOptions.map((stamp) => {
                      const nextPrinting = resolvePrintingSelection(printings, selectedPrinting, { stamp });
                      return {
                        key: stamp,
                        label: stamp,
                        href: toggleHref(slug, nextPrinting?.id ?? null, gradeSelection, debugEnabled),
                        active: selectedPrinting?.stamp === stamp,
                      };
                    })}
                  />
                </div>
              )}
              {printings.length > 1 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Printing</p>
                  <SegmentedControl
                    wrap
                    items={printings.map((row) => ({
                      key: row.id,
                      label: printingOptionLabel(row),
                      href: toggleHref(slug, row.id, gradeSelection, debugEnabled),
                      active: selectedPrinting?.id === row.id,
                    }))}
                  />
                </div>
              )}
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Grade</p>
                <SegmentedControl
                  items={GRADE_OPTIONS.map((option) => ({
                    key: option,
                    label: gradeLabel(option),
                    href: toggleHref(slug, selectedPrinting?.id ?? null, option, debugEnabled),
                    active: option === gradeSelection,
                  }))}
                />
              </div>
            </div>
          </GroupCard>
        </GroupedSection>

        {/* ── Market Intelligence ───────────────────────────────────────────────
            Primary signal tiles: 7D median, 7D change, trimmed 30D median,
            plus depth rows for velocity and spread. */}
        <MarketSnapshotTiles
          slug={slug}
          printingId={selectedPrinting?.id ?? null}
          grade={gradeSelection}
          initialData={snapshot}
        />

        {/* ── PopAlpha Signals ──────────────────────────────────────────────────
            Derived analytics. Only rendered when signal data exists. */}
        {vm?.signals && (
          <GroupedSection
            title="PopAlpha Signals"
            description="Computed nightly from price momentum, volatility, and activity data."
          >
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
                detail={gradeSelection === "RAW" ? "Current view" : undefined}
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
          grade={gradeSelection}
        />
      </div>
    </PageShell>
  );
}
