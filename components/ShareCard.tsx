type ShareCardProps = {
  title: string;
  grade?: string | null;
  scarcityScore?: number | null;
  percentHigher?: number | null;
  populationHigher?: number | null;
  totalPop?: number | null;
  isOneOfOne?: boolean;
  liquidityTier?: string | null;
  mode?: "square" | "landscape";
  className?: string;
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Data unavailable";
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Data unavailable";
  if (Number.isInteger(value)) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
}

function metricClass(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "text-muted text-base" : "text-app text-4xl";
}

export default function ShareCard({
  title,
  grade,
  scarcityScore,
  percentHigher,
  populationHigher,
  totalPop,
  isOneOfOne = false,
  liquidityTier,
  mode = "square",
  className = "",
}: ShareCardProps) {
  const isLandscape = mode === "landscape";
  const badgeLabel = isOneOfOne
    ? "🏆 1 of 1"
    : populationHigher === 0
      ? "Top tier"
      : percentHigher !== null && percentHigher !== undefined && percentHigher < 10
        ? "Upper tier"
        : null;
  const badgeClass =
    isOneOfOne
      ? "badge-gold"
      : "badge-positive";
  const scarcityDisplay =
    scarcityScore === null || scarcityScore === undefined || Number.isNaN(scarcityScore)
      ? "Data unavailable"
      : `Scarcity ${Math.round(scarcityScore)}/100`;

  return (
    <article
      className={`relative h-full w-full overflow-hidden rounded-[28px] border border-app text-app ${className}`}
      style={{
        background:
          "radial-gradient(760px circle at 8% 0%, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 58%)," +
          "radial-gradient(680px circle at 88% 100%, color-mix(in srgb, var(--color-positive) 14%, transparent), transparent 62%)," +
          "linear-gradient(165deg, color-mix(in srgb, var(--color-surface-soft) 84%, transparent), color-mix(in srgb, var(--color-surface) 96%, transparent))",
      }}
    >
      <div className={`grid h-full ${isLandscape ? "grid-rows-[auto_1fr_auto] p-10" : "grid-rows-[auto_1fr_auto] p-8 sm:p-10"}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.2em]">PopAlpha Intelligence</p>
            <p className={`${isLandscape ? "mt-2 text-5xl" : "mt-2 text-4xl"} font-semibold leading-none`}>{grade ?? "Canonical Asset"}</p>
            <p
              className={`${isLandscape ? "mt-4 text-[2.15rem]" : "mt-4 text-[1.9rem]"} max-w-full font-semibold leading-tight`}
              style={{
                display: "-webkit-box",
                overflow: "hidden",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {title}
            </p>
          </div>
          <div className="shrink-0">
            <div className="glass rounded-[18px] border-app border px-4 py-3">
              <div className="flex items-center gap-3">
                <div
                  className="h-10 w-10 rounded-full border border-app"
                  style={{
                    background: `conic-gradient(var(--color-accent) 0deg ${Math.max(0, Math.min(100, Math.round(scarcityScore ?? 0))) * 3.6}deg, color-mix(in srgb, var(--color-surface-soft) 85%, transparent) 0deg)`,
                  }}
                />
                <p className="text-sm font-semibold">{scarcityDisplay}</p>
              </div>
            </div>
          </div>
        </div>

        <div className={`mt-4 grid ${isLandscape ? "grid-cols-3" : "grid-cols-1 sm:grid-cols-2"} gap-3`}>
          <div className="glass rounded-[18px] border-app border p-4">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Percent higher</p>
            <p className={`mt-2 font-semibold tabular-nums ${metricClass(percentHigher)}`}>{formatPercent(percentHigher)}</p>
          </div>
          <div className="glass rounded-[18px] border-app border p-4">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Total population</p>
            <p className={`mt-2 font-semibold tabular-nums ${metricClass(totalPop)}`}>{formatNumber(totalPop)}</p>
          </div>
          <div className="glass rounded-[18px] border-app border p-4 sm:col-span-2 lg:col-span-1">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Liquidity tier</p>
            <p className={`mt-2 font-semibold ${liquidityTier ? "text-2xl text-app" : "text-base text-muted"}`}>
              {liquidityTier ?? "Data unavailable"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            {badgeLabel ? (
              <span className={`${badgeClass} inline-flex rounded-full border px-4 py-1.5 text-sm font-semibold`}>
                {badgeLabel}
              </span>
            ) : (
              <span className="text-muted text-sm">Data unavailable for badge classification.</span>
            )}
          </div>
          <p className="text-muted text-base font-semibold tracking-[0.08em]">POPALPHA</p>
        </div>
      </div>
    </article>
  );
}
