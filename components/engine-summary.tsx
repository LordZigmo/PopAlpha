"use client";

type EngineSummaryProps = {
  currentPrice: number | null;
  marketBalancePrice: number | null;
  signalTrend: number | null;
  signalTrendLabel: string | null;
  signalValue: number | null;
  signalValueLabel: string | null;
  liquidityScore: number | null;
  liquidityTier: string | null;
  priceChanges30d: number | null;
  spreadPercent: number | null;
};

function buildInsights(props: EngineSummaryProps): string[] {
  const lines: string[] = [];

  // Trend + momentum
  if (props.signalTrend !== null && props.signalTrendLabel) {
    if (props.signalTrend >= 67) {
      lines.push(`Strong upward momentum — trend signal reads ${props.signalTrendLabel.toLowerCase()}.`);
    } else if (props.signalTrend >= 33) {
      lines.push(`Moderate trend activity — signal reads ${props.signalTrendLabel.toLowerCase()}.`);
    } else {
      lines.push(`Weak or declining trend — signal reads ${props.signalTrendLabel.toLowerCase()}.`);
    }
  }

  // Value positioning
  if (props.signalValue !== null && props.signalValueLabel) {
    if (props.signalValue >= 67) {
      lines.push(`Priced below recent range — value signal is ${props.signalValueLabel.toLowerCase()}.`);
    } else if (props.signalValue <= 33) {
      lines.push(`Trading near recent highs — limited value upside.`);
    }
  }

  // Liquidity context
  if (props.liquidityScore !== null && props.liquidityTier) {
    if (props.liquidityScore >= 76) {
      const sales = props.priceChanges30d !== null ? ` with ${props.priceChanges30d} sales in 30 days` : "";
      lines.push(`High liquidity${sales} — easy to buy or sell.`);
    } else if (props.liquidityScore >= 51) {
      lines.push(`Active market — reasonable liquidity for trading.`);
    } else if (props.liquidityScore >= 26) {
      lines.push(`Thin market — patience may be needed to trade.`);
    } else {
      lines.push(`Low liquidity — few recent transactions observed.`);
    }
  }

  // Spread tightness
  if (props.spreadPercent !== null) {
    if (props.spreadPercent <= 10) {
      lines.push(`Tight spread at ${props.spreadPercent}% — pricing is stable.`);
    } else if (props.spreadPercent >= 40) {
      lines.push(`Wide spread at ${props.spreadPercent}% — significant price variance.`);
    }
  }

  return lines.slice(0, 3);
}

export default function EngineSummary(props: EngineSummaryProps) {
  const insights = buildInsights(props);

  if (insights.length === 0) return null;

  return (
    <div className="mt-6 rounded-2xl border border-white/[0.04] bg-white/[0.02] px-5 py-4">
      {insights.map((line, i) => (
        <p
          key={i}
          className="engine-line text-[15px] leading-relaxed text-[#999]"
          style={{ marginTop: i > 0 ? 4 : 0 }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}
