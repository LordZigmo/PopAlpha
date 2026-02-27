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

const shareColors = {
  shareBg:
    "radial-gradient(680px circle at 22% 12%, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 60%), linear-gradient(165deg, #0b1438, #08102b)",
  shareHeadlineGlow:
    "radial-gradient(520px circle at 20% 0%, color-mix(in srgb, #ffffff 14%, transparent), transparent 64%)",
  sharePanelBg: "color-mix(in srgb, #7ea1ff 18%, #172b66)",
  sharePanelText: "#f5f8ff",
  shareSecondaryText: "color-mix(in srgb, #f5f8ff 78%, #8ea4db)",
  shareGold: "#d8b35a",
  shareGreen: "#23d89f",
} as const;

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
  const hasImage = typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl);
  const normalizedOneOfOne = isOneOfOne || totalPop === 1;
  const isTopTier = !normalizedOneOfOne && populationHigher === 0;
  const isUpperTier =
    !normalizedOneOfOne &&
    !isTopTier &&
    typeof percentHigher === "number" &&
    Number.isFinite(percentHigher) &&
    percentHigher < 10;
  const claimHeadline = normalizedOneOfOne
    ? "1 of 1 at this grade"
    : isTopTier
      ? "Top tier - none higher recorded"
      : "Not top tier - higher grades exist";
  const badge = normalizedOneOfOne
    ? { label: "🏆 1 OF 1", tone: "gold" as const }
    : isTopTier
      ? { label: "TOP TIER", tone: "green" as const }
      : isUpperTier
        ? { label: "UPPER TIER", tone: "indigo" as const }
        : null;
  const verdictStyle = normalizedOneOfOne
    ? {
        borderColor: "color-mix(in srgb, var(--color-gold) 78%, transparent)",
        background:
          "linear-gradient(150deg, color-mix(in srgb, var(--color-gold) 26%, transparent), color-mix(in srgb, #1f1a0d 86%, #141b38))",
        boxShadow: "0 0 24px color-mix(in srgb, var(--color-gold) 22%, transparent)",
      }
    : isTopTier
      ? {
          borderColor: "color-mix(in srgb, var(--color-positive) 72%, transparent)",
          background:
            "linear-gradient(150deg, color-mix(in srgb, var(--color-positive) 24%, transparent), color-mix(in srgb, #0d1f22 78%, #112846))",
          boxShadow: "0 0 20px color-mix(in srgb, var(--color-positive) 18%, transparent)",
        }
      : {
          borderColor: "color-mix(in srgb, #9fb2ea 44%, transparent)",
          background: "linear-gradient(150deg, color-mix(in srgb, #89a4e2 16%, #1a2d68), #132452)",
          boxShadow: "none",
        };

  if (mode === "square") {
    return (
      <article
        className={`relative h-full w-full overflow-hidden rounded-[28px] border border-app text-app ${className}`}
        style={{
          background: `${shareColors.shareHeadlineGlow}, ${shareColors.shareBg}`,
        }}
      >
        <div className="grid h-full grid-rows-[1fr_auto] gap-5 p-14">
          <div className="grid min-h-0 grid-cols-[3fr_2fr] gap-6">
            <div className="min-h-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[1.75rem] font-semibold leading-none" style={{ color: shareColors.sharePanelText }}>
                    POPALPHA
                  </p>
                  <p className="mt-1 text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: shareColors.shareSecondaryText }}>
                    CERT RECAP
                  </p>
                </div>
                <p className="text-sm font-medium" style={{ color: shareColors.shareSecondaryText }}>
                  popalpha.app
                </p>
              </div>

              <div className="mt-7 max-w-[95%]">
                <p
                  className="text-[3.1rem] font-semibold leading-[1.02]"
                  style={{
                    color: shareColors.sharePanelText,
                    display: "-webkit-box",
                    overflow: "hidden",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {claimHeadline}
                </p>
              </div>

              <div className="mt-5">
                <p className="text-xl font-semibold leading-tight" style={{ color: shareColors.sharePanelText }}>
                  {grade ?? "Grade unavailable"}
                </p>
                <p
                  className="mt-2 text-base leading-tight"
                  style={{
                    color: shareColors.shareSecondaryText,
                    display: "-webkit-box",
                    overflow: "hidden",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {identityLineA || "Data unavailable"}
                </p>
                <p
                  className="mt-1 text-base leading-tight"
                  style={{
                    color: shareColors.shareSecondaryText,
                    display: "-webkit-box",
                    overflow: "hidden",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {identityLineB || "Data unavailable"}
                </p>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3">
                <div className="min-h-[44px]">
                  {badge ? (
                    <span
                      className="inline-flex rounded-full border px-5 py-2 text-base font-semibold tracking-[0.08em]"
                      style={
                        badge.tone === "gold"
                          ? {
                              borderColor: "color-mix(in srgb, var(--color-gold) 80%, transparent)",
                              background: "color-mix(in srgb, var(--color-gold) 22%, #201807)",
                              color: "#fff3d3",
                            }
                          : badge.tone === "green"
                            ? {
                                borderColor: "color-mix(in srgb, var(--color-positive) 72%, transparent)",
                                background: "color-mix(in srgb, var(--color-positive) 20%, #102a24)",
                                color: "#dfffee",
                              }
                            : {
                                borderColor: "color-mix(in srgb, var(--color-accent) 70%, transparent)",
                                background: "color-mix(in srgb, var(--color-accent) 22%, #192453)",
                                color: "#e9eeff",
                              }
                      }
                    >
                      {badge.label}
                    </span>
                  ) : null}
                </div>
                <div className="h-20 w-16 overflow-hidden rounded-2xl border border-app" style={{ background: shareColors.sharePanelBg }}>
                  {hasImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl} alt="Card preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-1 text-center text-[9px] font-medium" style={{ color: shareColors.shareSecondaryText }}>
                      image coming soon
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
              <div className="rounded-[20px] border p-5" style={verdictStyle}>
                <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: shareColors.shareSecondaryText }}>
                  VERDICT
                </p>
                <p className="mt-2 text-[2.3rem] font-semibold leading-none" style={{ color: shareColors.sharePanelText }}>
                  {normalizedOneOfOne ? "1 of 1" : isTopTier ? "Top tier" : "Not top tier"}
                </p>
                <p className="mt-2 text-sm leading-tight" style={{ color: shareColors.sharePanelText }}>
                  {normalizedOneOfOne
                    ? "Unique population at this grade"
                    : isTopTier
                      ? "No higher examples recorded"
                      : "Higher grades are recorded"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[16px] border p-4" style={{ background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 28%, transparent)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: shareColors.shareSecondaryText }}>
                    Scarcity
                  </p>
                  <p className="mt-1 text-[2rem] font-semibold leading-none" style={{ color: shareColors.sharePanelText }}>
                    {scarcityScore === null || scarcityScore === undefined ? "Data unavailable" : `${Math.round(scarcityScore)}/100`}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: shareColors.shareSecondaryText }}>scarcity score</p>
                </div>
                <div className="rounded-[16px] border p-4" style={{ background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 28%, transparent)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: shareColors.shareSecondaryText }}>
                    Percent higher
                  </p>
                  <p className="mt-1 text-[2rem] font-semibold leading-none tabular-nums" style={{ color: shareColors.sharePanelText }}>
                    {formatPercent(percentHigher)}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: shareColors.shareSecondaryText }}>graded higher</p>
                </div>
                <div className="rounded-[16px] border p-4" style={{ background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 28%, transparent)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: shareColors.shareSecondaryText }}>
                    Total pop
                  </p>
                  <p className="mt-1 text-[2rem] font-semibold leading-none tabular-nums" style={{ color: shareColors.sharePanelText }}>
                    {formatNumber(totalPop)}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: shareColors.shareSecondaryText }}>total graded</p>
                </div>
                <div className="rounded-[16px] border p-4" style={{ background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 28%, transparent)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: shareColors.shareSecondaryText }}>
                    Liquidity
                  </p>
                  <p
                    className="mt-1 text-[1.55rem] font-semibold leading-none"
                    style={{
                      color: shareColors.sharePanelText,
                      display: "-webkit-box",
                      overflow: "hidden",
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {liquidityTier ?? "Data unavailable"}
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: shareColors.shareSecondaryText }}>market depth</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-end justify-between border-t pt-3" style={{ borderColor: "color-mix(in srgb, #bdd2ff 28%, transparent)" }}>
            <p className="text-sm" style={{ color: shareColors.shareSecondaryText }}>popalpha.app</p>
            <p className="text-base font-semibold tracking-[0.08em]" style={{ color: shareColors.shareSecondaryText }}>POPALPHA</p>
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
