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
  shareHeadlineGlow:
    "radial-gradient(520px circle at 20% 0%, color-mix(in srgb, #ffffff 14%, transparent), transparent 64%)",
  sharePanelBg: "color-mix(in srgb, #7ea1ff 18%, #172b66)",
  sharePanelText: "#f5f8ff",
  shareSecondaryText: "color-mix(in srgb, #f5f8ff 78%, #8ea4db)",
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
  const claimHeadline = normalizedOneOfOne
    ? "🏆 1 of 1 at this grade"
    : isTopTier
      ? "Top tier - none higher recorded"
      : "Not top tier - higher grades exist";
  const insightLine = normalizedOneOfOne
    ? "Only graded example at this level."
    : isTopTier
      ? "No higher grades recorded."
      : typeof percentHigher === "number" && Number.isFinite(percentHigher)
        ? `${formatPercent(percentHigher)} graded higher.`
        : "Higher-grade share unavailable.";
  const liquidityDisplay = liquidityTier === "Ultra thin market" ? "Ultra thin" : (liquidityTier ?? "Data unavailable");

  if (mode === "square") {
    return (
      <article
        className={`relative h-full w-full overflow-hidden rounded-[28px] border border-app text-app ${className}`}
        style={{
          background:
            "radial-gradient(620px circle at 20% 10%, color-mix(in srgb, var(--color-accent) 18%, transparent), transparent 58%)," +
            "linear-gradient(165deg, #0c1536, #0a122c)",
        }}
      >
        <div className="grid h-full grid-rows-[1fr_auto] gap-6 p-14">
          <div className="mx-auto flex h-full w-full max-w-[968px] flex-col gap-7">
            <header>
              <p className="text-[1.75rem] font-semibold leading-none" style={{ color: shareColors.sharePanelText }}>
                POPALPHA
              </p>
              <p className="mt-1 text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: shareColors.shareSecondaryText }}>
                CERT RECAP
              </p>
            </header>

            <section className="space-y-4">
              <div style={{ background: shareColors.shareHeadlineGlow }} className="rounded-2xl">
                <p
                  className="text-[3.05rem] font-semibold leading-[1.03]"
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
              <div className="space-y-1">
                <p className="text-[1.35rem] font-semibold leading-tight" style={{ color: shareColors.sharePanelText }}>
                  {grade ?? "Grade unavailable"}
                </p>
                <p
                  className="text-base leading-tight"
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
            </section>

            <section className="grid grid-cols-[1fr_292px] items-start gap-6">
              <div className="rounded-2xl border px-5 py-4" style={{ background: "color-mix(in srgb, #6b90ff 14%, #15295f)", borderColor: "color-mix(in srgb, #d9e5ff 24%, transparent)" }}>
                <p className="text-sm leading-relaxed font-medium" style={{ color: "color-mix(in srgb, #f5f8ff 86%, #91a6dc)" }}>
                  {insightLine}
                </p>
              </div>
              <div className="space-y-2">
                <div className="h-[292px] w-[292px] overflow-hidden rounded-[24px] border" style={{ background: "linear-gradient(155deg, color-mix(in srgb, #8ea8ff 24%, #243f86), #1a2f67)", borderColor: "color-mix(in srgb, #dce7ff 30%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, #eef4ff 16%, transparent)" }}>
                  <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
                    {hasImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imageUrl} alt="Card preview" className="h-full w-full object-cover" />
                    ) : (
                      <>
                        <div className="h-16 w-16 rounded-2xl border border-app bg-surface/40" />
                        <p className="mt-3 text-sm font-semibold" style={{ color: shareColors.shareSecondaryText }}>Image coming soon</p>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs text-center font-medium" style={{ color: shareColors.shareSecondaryText }}>
                  {hasImage ? (
                    "PSA scan"
                  ) : (
                    "PSA scan not available"
                  )}
                </p>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-4">
              <div className="rounded-[16px] border px-4 py-3" style={{ minHeight: 148, background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 30%, transparent)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "color-mix(in srgb, #f5f8ff 88%, #99afdf)" }}>
                  Scarcity
                </p>
                <div className="mt-3 flex min-h-[56px] items-center">
                  <p className="text-[2.35rem] font-semibold leading-none" style={{ color: shareColors.sharePanelText }}>
                    {scarcityScore === null || scarcityScore === undefined ? "Data unavailable" : `${Math.round(scarcityScore)}/100`}
                  </p>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "color-mix(in srgb, #f5f8ff 85%, #8ea4db)" }}>scarcity score</p>
              </div>
              <div className="rounded-[16px] border px-4 py-3" style={{ minHeight: 148, background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 30%, transparent)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "color-mix(in srgb, #f5f8ff 88%, #99afdf)" }}>
                  Percent higher
                </p>
                <div className="mt-3 flex min-h-[56px] items-center">
                  <p className="text-[2.35rem] font-semibold leading-none tabular-nums" style={{ color: shareColors.sharePanelText }}>
                    {formatPercent(percentHigher)}
                  </p>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "color-mix(in srgb, #f5f8ff 85%, #8ea4db)" }}>graded higher</p>
              </div>
              <div className="rounded-[16px] border px-4 py-3" style={{ minHeight: 148, background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 30%, transparent)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "color-mix(in srgb, #f5f8ff 88%, #99afdf)" }}>
                  Total pop
                </p>
                <div className="mt-3 flex min-h-[56px] items-center">
                  <p className="text-[2.35rem] font-semibold leading-none tabular-nums" style={{ color: shareColors.sharePanelText }}>
                    {formatNumber(totalPop)}
                  </p>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "color-mix(in srgb, #f5f8ff 85%, #8ea4db)" }}>total graded</p>
              </div>
              <div className="rounded-[16px] border px-4 py-3" style={{ minHeight: 148, background: shareColors.sharePanelBg, borderColor: "color-mix(in srgb, #dce7ff 30%, transparent)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "color-mix(in srgb, #f5f8ff 88%, #99afdf)" }}>
                  Liquidity
                </p>
                <div className="mt-3 flex min-h-[56px] items-center">
                  <p
                    className="text-[1.9rem] font-semibold leading-tight"
                    style={{
                      color: shareColors.sharePanelText,
                      display: "-webkit-box",
                      overflow: "hidden",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {liquidityDisplay}
                  </p>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "color-mix(in srgb, #f5f8ff 85%, #8ea4db)" }}>market depth</p>
              </div>
            </section>
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
