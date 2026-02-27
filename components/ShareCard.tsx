type ShareCardProps = {
  title: string;
  grade?: string | null;
  scarcityScore?: number | null;
  percentHigher?: number | null;
  populationHigher?: number | null;
  totalPop?: number | null;
  isOneOfOne?: boolean;
  liquidityTier?: string | null;
  imageUrl?: string | null;
  mode?: "square" | "landscape";
  className?: string;
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Data unavailable";
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Data unavailable";
  if (Math.abs(value) < 0.05) return "0%";
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
  imageUrl,
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
  const segments = title
    .split("•")
    .map((value) => value.trim())
    .filter(Boolean);
  const identityLineA = segments.slice(0, 2).join(" • ") || title;
  const identityLineB = segments.slice(2).join(" • ");
  const verdict = isOneOfOne
    ? {
        main: "1 of 1",
        sub: "Unique population at this grade",
        className: "badge-gold",
      }
    : populationHigher === 0
      ? {
          main: "Top tier",
          sub: "No higher examples recorded",
          className: "tier-label-premium text-app",
        }
      : {
          main: "Not top tier",
          sub: "Higher grades are recorded",
          className: "border-app bg-surface-soft/55",
        };
  const hasImage = typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl);

  if (mode === "square") {
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
        <div className="grid h-full grid-rows-[1fr_auto] gap-6 p-14">
          <div className="grid min-h-0 grid-cols-[3fr_2fr] gap-6">
            <div className="flex min-h-0 flex-col">
              <div>
                <p className="text-muted text-xs font-semibold uppercase tracking-[0.2em]">POPALPHA INTELLIGENCE</p>
                <p className="mt-3 text-6xl font-semibold leading-none">{grade ?? "Canonical Asset"}</p>
                <p
                  className="mt-4 text-xl font-semibold leading-tight"
                  style={{
                    display: "-webkit-box",
                    overflow: "hidden",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {identityLineA}
                </p>
                <p
                  className="text-muted mt-1 text-lg leading-tight"
                  style={{
                    display: "-webkit-box",
                    overflow: "hidden",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {identityLineB || "Data unavailable"}
                </p>
              </div>

              <div className="mt-6 flex min-h-0 flex-1 items-end">
                <div className="glass h-[360px] w-[360px] overflow-hidden rounded-[24px] border-app border">
                  {hasImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl} alt="Card preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--color-accent)_24%,transparent),transparent_54%),linear-gradient(150deg,color-mix(in_srgb,var(--color-surface-soft)_86%,transparent),color-mix(in_srgb,var(--color-border)_30%,transparent))]">
                      <div className="h-14 w-14 rounded-2xl border border-app bg-surface/60" />
                      <p className="text-muted mt-3 text-sm font-semibold">Image coming soon</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
              <div className={`rounded-[20px] border p-5 ${verdict.className}`}>
                <p className="text-muted text-xs font-semibold uppercase tracking-[0.16em]">VERDICT</p>
                <p className="mt-3 text-4xl font-semibold leading-none">{verdict.main}</p>
                <p className="mt-2 text-sm">{verdict.sub}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="glass rounded-[16px] border-app border p-4">
                  <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Scarcity</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {scarcityScore === null || scarcityScore === undefined ? "Data unavailable" : `${Math.round(scarcityScore)}/100`}
                  </p>
                </div>
                <div className="glass rounded-[16px] border-app border p-4">
                  <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Percent higher</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{formatPercent(percentHigher)}</p>
                </div>
                <div className="glass rounded-[16px] border-app border p-4">
                  <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Total pop</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totalPop)}</p>
                </div>
                <div className="glass rounded-[16px] border-app border p-4">
                  <p className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Liquidity</p>
                  <p
                    className="mt-1 text-xl font-semibold"
                    style={{
                      display: "-webkit-box",
                      overflow: "hidden",
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {liquidityTier ?? "Data unavailable"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-end justify-between border-app border-t pt-3">
            <p className="text-muted text-sm">popalpha.app</p>
            <p className="text-muted text-base font-semibold tracking-[0.08em]">POPALPHA</p>
          </div>
        </div>
      </article>
    );
  }

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
