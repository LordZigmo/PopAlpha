/**
 * README
 * Primitives: PageShell, NavBar, GroupedSection, GroupCard, StatRow, StatTile, SegmentedControl, Pill, Skeleton.
 * Layout: sticky compact nav, identity card, grouped controls, primary signals, secondary snapshots, then market dashboards and listings.
 * iOS grouped rules: matte dark surfaces, consistent radii and spacing, restrained separators, and touch targets sized for mobile-first interaction.
 */
import { notFound } from "next/navigation";
import CanonicalCardFloatingHero from "@/components/canonical-card-floating-hero";
import CardDetailNavBar from "@/components/card-detail-nav-bar";
import EbayListings from "@/components/ebay-listings";
import { GroupCard, GroupedSection, PageShell, Pill, SegmentedControl, StatRow, StatTile } from "@/components/ios-grouped-ui";
import MarketSnapshotTiles from "@/components/market-snapshot-tiles";
import { buildEbayQuery, type GradeSelection } from "@/lib/ebay-query";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
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
  median_ask_7d: number | null;
  median_ask_30d: number | null;
  trimmed_median_30d: number | null;
  low_ask_30d: number | null;
  high_ask_30d: number | null;
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
  if (value === null || value === undefined || !Number.isFinite(value)) return "Collecting";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function marketSignalTone(value: number | null | undefined): "neutral" | "positive" {
  if (value === null || value === undefined || !Number.isFinite(value)) return "neutral";
  return "positive";
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
  const stampOptions = Array.from(new Set(printings.map((row) => row.stamp).filter((value): value is string => Boolean(value))));

  const { data: snapshotData } = await supabase
    .from("market_snapshot_rollups")
    .select("active_listings_7d, median_ask_7d, median_ask_30d, trimmed_median_30d, low_ask_30d, high_ask_30d")
    .eq("canonical_slug", slug)
    .eq("grade", gradeSelection)
    .is("printing_id", selectedPrinting?.id ?? null)
    .maybeSingle<SnapshotRow>();

  const snapshot = snapshotData
    ? {
        ok: true,
        active7d: snapshotData.active_listings_7d ?? 0,
        median7d: snapshotData.median_ask_7d,
        median30d: snapshotData.median_ask_30d,
        trimmedMedian30d: snapshotData.trimmed_median_30d,
        low30d: snapshotData.low_ask_30d,
        high30d: snapshotData.high_ask_30d,
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

  return (
    <PageShell>
      <CardDetailNavBar title={canonical.canonical_name} subtitle={selectedPrintingLabel} />

      <div className="mx-auto max-w-5xl px-4 pb-[max(env(safe-area-inset-bottom),2.5rem)] pt-4 sm:px-6 sm:pb-[max(env(safe-area-inset-bottom),3.5rem)]">
        <GroupedSection>
          <CanonicalCardFloatingHero
            imageUrl={selectedPrinting?.image_url ?? null}
            title={canonical.canonical_name}
            overlay={
              <GroupCard
                inset
                header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Canonical Card</p>}
              >
                <div className="divide-y divide-white/[0.06]">
                  <StatRow label="Name" value={canonical.canonical_name} />
                  <StatRow label="Set" value={canonical.set_name ?? "Unknown set"} />
                  <StatRow label="Card number" value={canonical.card_number ? `#${canonical.card_number}` : "Unknown"} />
                  <StatRow label="Year" value={canonical.year ?? "Unknown"} />
                  <StatRow label="Printing shown" value={selectedPrintingLabel} />
                </div>
              </GroupCard>
            }
          />

          <GroupCard>
            <div className="rounded-[24px] border border-white/[0.06] bg-[#141820] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-[#f5f7fb] sm:text-[36px]">
                    {canonical.canonical_name}
                  </h1>
                  <p className="mt-2 text-[15px] text-[#98a0ae]">
                    {canonical.set_name ?? "Unknown set"}
                    {canonical.card_number ? ` • #${canonical.card_number}` : ""}
                    {canonical.year ? ` • ${canonical.year}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Pill label={selectedPrintingLabel} tone={selectedPrinting ? "neutral" : "warning"} />
                  <Pill label={gradeLabel(gradeSelection)} tone="neutral" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Pill label={`Scarcity ${scarcity.label}`} tone={scarcity.tone} />
                <Pill label={`Liquidity ${liquidity.label}`} tone={liquidity.tone} />
                <Pill
                  label={snapshotData?.median_ask_7d !== null && snapshotData?.median_ask_7d !== undefined ? "Price signal live" : "Collecting"}
                  tone={marketSignalTone(snapshotData?.median_ask_7d)}
                />
              </div>
            </div>
          </GroupCard>
        </GroupedSection>

        <GroupedSection title="Controls" description="Select printing and grade without leaving the signal view.">
          <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Filters</p>}>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Finish</p>
                <SegmentedControl
                  wrap
                  items={
                    finishOptions.length
                      ? finishOptions.map((finish) => {
                          const nextPrinting = resolvePrintingSelection(printings, selectedPrinting, { finish });
                          return {
                            key: finish,
                            label: finishLabel(finish),
                            href: toggleHref(slug, nextPrinting?.id ?? null, gradeSelection, debugEnabled),
                            active: selectedPrinting?.finish === finish,
                          };
                        })
                      : [
                          {
                            key: "unknown-finish",
                            label: "Unknown finish",
                            active: true,
                            disabled: true,
                          },
                        ]
                  }
                />
              </div>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Edition</p>
                <SegmentedControl
                  wrap
                  items={
                    editionOptions.length
                      ? editionOptions.map((edition) => {
                          const nextPrinting = resolvePrintingSelection(printings, selectedPrinting, { edition });
                          return {
                            key: edition,
                            label: editionLabel(edition),
                            href: toggleHref(slug, nextPrinting?.id ?? null, gradeSelection, debugEnabled),
                            active: selectedPrinting?.edition === edition,
                          };
                        })
                      : [
                          {
                            key: "unknown-edition",
                            label: "Unknown edition",
                            active: true,
                            disabled: true,
                          },
                        ]
                  }
                />
              </div>
              {stampOptions.length ? (
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
              ) : null}
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[#98a0ae]">Exact printing</p>
                <SegmentedControl
                  wrap
                  items={
                    printings.length
                      ? printings.map((row) => ({
                          key: row.id,
                          label: printingOptionLabel(row),
                          href: toggleHref(slug, row.id, gradeSelection, debugEnabled),
                          active: selectedPrinting?.id === row.id,
                        }))
                      : [
                          {
                            key: "unknown",
                            label: "Unknown printing",
                            active: true,
                            disabled: true,
                          },
                        ]
                  }
                />
              </div>
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

        <GroupedSection title="Primary Signals" description="Fast, comparable reads for scarcity, liquidity, and price.">
          <div className="grid gap-3 md:grid-cols-3">
            <StatTile label="Scarcity" value={scarcity.label} detail={snapshotData?.active_listings_7d === null ? "Forming" : "Live ask depth"} tone={scarcity.tone} />
            <StatTile label="Liquidity" value={liquidity.label} detail={snapshotData?.active_listings_7d === null ? "Forming" : "7-day activity"} tone={liquidity.tone} />
            <StatTile
              label="Price Signal"
              value={formatUsdCompact(snapshotData?.median_ask_7d)}
              detail={
                snapshotData?.median_ask_7d !== null && snapshotData?.median_ask_7d !== undefined
                  ? "Current 7-day median"
                  : "Collecting"
              }
              tone={marketSignalTone(snapshotData?.median_ask_7d)}
            />
          </div>
        </GroupedSection>

        <GroupedSection title="Market Snapshot" description="Population and pricing context in one grouped view.">
          <div className="grid gap-3 lg:grid-cols-2">
            <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Population Snapshot</p>}>
              <div className="divide-y divide-white/[0.06]">
                <StatRow
                  label="Observed live asks"
                  value={snapshotData?.active_listings_7d ? `${snapshotData.active_listings_7d} / 7D` : "Collecting"}
                  meta={snapshotData?.active_listings_7d ? "Observed across recent sessions" : "Waiting for enough observations"}
                />
                <StatRow label="Median ask (7D)" value={formatUsdCompact(snapshotData?.median_ask_7d)} meta="Primary pricing read" />
                <StatRow label="Median ask (30D)" value={formatUsdCompact(snapshotData?.median_ask_30d)} meta="Longer baseline" />
              </div>
            </GroupCard>

            <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">TCG Snapshot</p>}>
              <div className="grid gap-3 sm:grid-cols-2">
                <StatTile label="Market" value={formatUsdCompact(tcgSnapshot.item?.marketPrice)} detail={tcgSnapshot.item ? "TCG market" : "Collecting"} />
                <StatTile label="Low" value={formatUsdCompact(tcgSnapshot.item?.lowPrice)} detail={tcgSnapshot.item ? "Lowest seen" : "Collecting"} />
                <StatTile label="Mid" value={formatUsdCompact(tcgSnapshot.item?.midPrice)} detail={tcgSnapshot.item ? "Midpoint" : "Collecting"} />
                <StatTile label="High" value={formatUsdCompact(tcgSnapshot.item?.highPrice)} detail={tcgSnapshot.item ? "Upper range" : "Collecting"} />
              </div>
              <div className="mt-4 border-t border-white/[0.06] pt-4">
                <p className="text-[13px] text-[#8c94a3]">
                  {tcgSnapshot.item
                    ? `${tcgSnapshot.setName ?? "Matched set"}${tcgSnapshot.updatedAt ? ` • Updated ${new Date(tcgSnapshot.updatedAt).toLocaleDateString()}` : ""}`
                    : "Collecting"}
                </p>
              </div>
            </GroupCard>
          </div>
        </GroupedSection>

        {debugEnabled ? (
          <GroupedSection title="TCG Match Debug" description="Resolution details for set and product matching.">
            <div className="grid gap-3 lg:grid-cols-3">
              <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">Canonical</p>}>
                <div className="divide-y divide-white/[0.06]">
                  <StatRow label="Name" value={tcgSnapshot.debug.canonical.name} />
                  <StatRow label="Set" value={tcgSnapshot.debug.canonical.setName ?? "Unknown"} />
                  <StatRow label="Number" value={tcgSnapshot.debug.canonical.cardNumber ?? "Unknown"} />
                  <StatRow label="Year" value={tcgSnapshot.debug.canonical.year ?? "Unknown"} />
                  <StatRow label="Printing" value={`${tcgSnapshot.debug.canonical.finish ?? "Unknown"} / ${tcgSnapshot.debug.canonical.edition ?? "Unknown"}`} />
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
                          {candidate.id} • Code {candidate.code ?? "n/a"} • Year {candidate.year ?? "n/a"} • Score {candidate.score}
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
                  <StatRow label="Reason" value={tcgSnapshot.debug.productResolution?.chosenReason ?? "No reason recorded"} />
                </div>
                <div className="mt-4 space-y-2">
                  {tcgSnapshot.debug.productResolution?.warning ? <Pill label={tcgSnapshot.debug.productResolution.warning} tone="warning" /> : null}
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

        <MarketSnapshotTiles slug={slug} printingId={selectedPrinting?.id ?? null} grade={gradeSelection} initialData={snapshot} />

        <GroupedSection title="Price History" description="Rolling medians update as PopAlpha observes listings.">
          <GroupCard header={<p className="text-[15px] font-semibold text-[#f5f7fb]">History</p>}>
            <SegmentedControl
              items={["7D", "30D", "90D", "All"].map((range, index) => ({
                key: range,
                label: range,
                active: index === 1,
                disabled: true,
              }))}
            />
            <div className="mt-4 rounded-[24px] border border-white/[0.06] bg-[#11151d] p-4">
              <div className="h-44 rounded-[20px] border border-white/[0.05] bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:22px_22px]" />
              <p className="mt-3 text-[14px] font-semibold text-[#f5f7fb]">Graph coming soon</p>
              <p className="mt-1 text-[12px] text-[#8c94a3]">The grouped container is in place so the live chart can drop in without changing layout.</p>
            </div>
          </GroupCard>
        </GroupedSection>

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
