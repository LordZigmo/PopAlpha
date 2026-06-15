/**
 * Card-detail parity sections ported from the native iOS CardDetailView.
 * Pure presentational, server-renderable — fed from the page's snapshot row.
 * Each self-hides when it has nothing meaningful to show (matches the iOS
 * conditional-section behavior). Styled with the shared iOS-grouped primitives.
 */
import Link from "next/link";
import { GroupedSection, GroupCard, StatRow } from "@/components/ios-grouped-ui";
import { priceObservationDensityLabel } from "@/lib/pricing/price-observation-density";

type Tone = "neutral" | "positive" | "negative" | "warning";

function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function fmtJpy(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `¥${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}

// UTC-pinned so server and client render the identical string (see the
// hydration-mismatch fix in view-history-chart.tsx / market-pulse.tsx).
function fmtAsOfUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function confidenceLabel(score: number | null | undefined): { label: string; tone: Tone } {
  if (score == null || !Number.isFinite(score)) return { label: "—", tone: "neutral" };
  if (score >= 80) return { label: "High", tone: "positive" };
  if (score >= 60) return { label: "Solid", tone: "positive" };
  if (score >= 40) return { label: "Watch", tone: "neutral" };
  return { label: "Low", tone: "warning" };
}

// volatility_30d is a coefficient of variation in percent: stddev_30d / median_30d * 100.
// Banded honestly rather than mirroring iOS's hardcoded "Low".
function volatilityBand(cvPct: number | null | undefined): { label: string; tone: Tone } | null {
  if (cvPct == null || !Number.isFinite(cvPct)) return null;
  const pct = Math.round(cvPct);
  if (cvPct < 10) return { label: `Low · ${pct}%`, tone: "positive" };
  if (cvPct < 25) return { label: `Moderate · ${pct}%`, tone: "neutral" };
  return { label: `High · ${pct}%`, tone: "warning" };
}

function feedLabelFromToken(token: string | null | undefined): string | null {
  const raw = String(token ?? "").trim().toUpperCase();
  if (raw.includes("YAHOO")) return "Yahoo! Auctions JP";
  if (raw.includes("SNKRDUNK")) return "Snkrdunk";
  if (raw.includes("PRICECHARTING")) return "PriceCharting";
  if (raw.includes("SCRYDEX") || raw.includes("POKEMON_TCG")) return "Scrydex";
  return null;
}

function priceSourceLabel(provenance: unknown, blendPolicy: string | null | undefined): string | null {
  // "Price Source" must name the actual data FEED — never an internal trust /
  // confidence policy. market_blend_policy is dominated by trust-state enums
  // (POPALPHA_MARKET_CONFIDENT / _LOW_CONFIDENCE / _QUARANTINED / _SINGLE_SOURCE,
  // NO_PRICE / NO_RELIABLE_PRICE, OUTLIER_SUPPRESSED) that are NOT sources, so
  // accept only feed-named tokens and otherwise derive the feed from the
  // provenance source mix. Anything we can't resolve to a feed is omitted
  // rather than shown as a raw/humanized enum.
  const provObj = provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>) : null;
  const selectedProvider = provObj && typeof provObj.selectedProvider === "string" ? provObj.selectedProvider : null;
  const sourceMix = provObj && provObj.sourceMix && typeof provObj.sourceMix === "object"
    ? (provObj.sourceMix as Record<string, unknown>)
    : null;
  const scrydexWeight = sourceMix && typeof sourceMix.scrydexWeight === "number" ? sourceMix.scrydexWeight : 0;

  return (
    feedLabelFromToken(selectedProvider) ??
    feedLabelFromToken(blendPolicy) ??
    // Blended PopAlpha rows carry a trust-state policy, not a feed name — name
    // the underlying feed when the source mix tells us, else omit the row.
    (scrydexWeight > 0 ? "Scrydex" : null)
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-[#F0F0F0]",
  positive: "text-[#00DC5A]",
  negative: "text-[#FF3B30]",
  warning: "text-amber-200",
};

function MetaText({ children }: { children: React.ReactNode }) {
  return <span className="text-[14px] tabular-nums text-[#6B6B6B]">{children}</span>;
}

export function CardDetailsGrid({
  setName,
  setHref,
  cardNumber,
  confidenceScore,
  activeListings7d,
}: {
  setName: string | null;
  setHref: string | null;
  cardNumber: string | null;
  confidenceScore: number | null;
  activeListings7d: number | null;
}) {
  const conf = confidenceLabel(confidenceScore);
  const liquidity = priceObservationDensityLabel(activeListings7d);
  const liqTone: Tone = liquidity.tone === "warning" ? "neutral" : liquidity.tone;

  const tiles: Array<{ label: string; value: React.ReactNode; tone?: Tone }> = [
    {
      label: "Set",
      value:
        setName && setHref ? (
          <Link href={setHref} className="text-[#F0F0F0] hover:text-[#DDE8FF]">
            {setName}
          </Link>
        ) : (
          setName ?? "—"
        ),
    },
    { label: "Number", value: cardNumber ? `#${cardNumber}` : "—" },
    { label: "Confidence", value: conf.label, tone: conf.tone },
    { label: "Liquidity", value: liquidity.label, tone: liqTone },
  ];

  return (
    <GroupedSection title="Details">
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-2xl border border-white/[0.06] bg-[#111111] px-4 py-3.5"
          >
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">
              {tile.label}
            </p>
            <p className={`mt-1.5 truncate text-[18px] font-semibold tracking-[-0.02em] ${TONE_TEXT[tile.tone ?? "neutral"]}`}>
              {tile.value}
            </p>
          </div>
        ))}
      </div>
    </GroupedSection>
  );
}

export function JpNativeSources({
  yahooPrice,
  yahooPriceJpy,
  yahooSamples,
  snkrdunkPrice,
  snkrdunkSamples,
}: {
  yahooPrice: number | null;
  yahooPriceJpy: number | null;
  yahooSamples: number | null;
  snkrdunkPrice: number | null;
  snkrdunkSamples: number | null;
}) {
  const hasYahoo = yahooPrice != null && Number.isFinite(yahooPrice);
  const hasSnkrdunk = snkrdunkPrice != null && Number.isFinite(snkrdunkPrice);
  // Self-hide for EN cards (both null) — same gate iOS uses.
  if (!hasYahoo && !hasSnkrdunk) return null;

  // Yahoo auctions are natively in yen, so the JPY is real. Snkrdunk's feed
  // serves USD directly and its `price_jpy` is an FX-derived approximation
  // (not a listed yen value) — so we omit it rather than imply a native price,
  // matching iOS (which sets Snkrdunk jpy: nil).
  const yahooMeta = [fmtJpy(yahooPriceJpy), yahooSamples ? `n=${yahooSamples}` : null].filter(Boolean).join(" · ");
  const snkrdunkMeta = snkrdunkSamples ? `n=${snkrdunkSamples}` : "";

  return (
    <GroupedSection title="Native Sources">
      <GroupCard>
        <div className="divide-y divide-white/[0.06]">
          {hasYahoo ? (
            <StatRow
              label="Yahoo! Auctions JP"
              value={fmtUsd(yahooPrice)}
              meta={yahooMeta ? <MetaText>{yahooMeta}</MetaText> : undefined}
            />
          ) : null}
          {hasSnkrdunk ? (
            <StatRow
              label="Snkrdunk"
              value={fmtUsd(snkrdunkPrice)}
              meta={snkrdunkMeta ? <MetaText>{snkrdunkMeta}</MetaText> : undefined}
            />
          ) : null}
        </div>
      </GroupCard>
    </GroupedSection>
  );
}

export function MarketIntelligenceSection({
  marketProvenance,
  marketBlendPolicy,
  marketPriceAsOf,
  median7d,
  volatilityCvPct,
  confidenceScore,
  sampleCount30d,
}: {
  marketProvenance: unknown;
  marketBlendPolicy: string | null;
  marketPriceAsOf: string | null;
  median7d: number | null;
  volatilityCvPct: number | null;
  confidenceScore: number | null;
  sampleCount30d: number | null;
}) {
  const source = priceSourceLabel(marketProvenance, marketBlendPolicy);
  const asOf = fmtAsOfUtc(marketPriceAsOf);
  const vol = volatilityBand(volatilityCvPct);
  const conf = confidenceLabel(confidenceScore);

  const rows: React.ReactNode[] = [];
  if (source) rows.push(<StatRow key="src" label="Price Source" value={source} />);
  if (asOf) rows.push(<StatRow key="asof" label="Last Refreshed" value={asOf} />);
  if (median7d != null && Number.isFinite(median7d)) {
    rows.push(<StatRow key="med" label="7-Day Median" value={fmtUsd(median7d)} />);
  }
  if (vol) {
    rows.push(
      <StatRow key="vol" label="Volatility" value={<span className={TONE_TEXT[vol.tone]}>{vol.label}</span>} />,
    );
  }
  if (confidenceScore != null && Number.isFinite(confidenceScore)) {
    rows.push(
      <StatRow
        key="conf"
        label="Sample Confidence"
        value={<span className={TONE_TEXT[conf.tone]}>{conf.label}</span>}
        meta={sampleCount30d != null ? <MetaText>{`${sampleCount30d} obs · 30d`}</MetaText> : undefined}
      />,
    );
  }

  if (rows.length === 0) return null;

  return (
    <GroupedSection title="Market Intelligence">
      <GroupCard>
        <div className="divide-y divide-white/[0.06]">{rows}</div>
      </GroupCard>
    </GroupedSection>
  );
}
