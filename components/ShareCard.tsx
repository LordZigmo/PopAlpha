type ShareCardProps = {
  title: string;
  grade?: string | null;
  scarcityScore?: number | null;
  percentHigher?: number | null;
  totalPop?: number | null;
  isOneOfOne?: boolean;
  liquidityTier?: string | null;
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export default function ShareCard({
  title,
  grade,
  scarcityScore,
  percentHigher,
  totalPop,
  isOneOfOne = false,
  liquidityTier,
}: ShareCardProps) {
  return (
    <article
      className="relative h-[630px] w-[1200px] overflow-hidden rounded-[28px] border border-app text-app"
      style={{
        background:
          "radial-gradient(760px circle at 8% 0%, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 58%)," +
          "radial-gradient(680px circle at 88% 100%, color-mix(in srgb, var(--color-positive) 14%, transparent), transparent 62%)," +
          "linear-gradient(165deg, color-mix(in srgb, var(--color-surface-soft) 84%, transparent), color-mix(in srgb, var(--color-surface) 96%, transparent))",
      }}
    >
      <div className="flex h-full flex-col justify-between p-12">
        <div className="space-y-7">
          <div className="flex items-start justify-between gap-8">
            <div>
              <p className="text-muted text-sm font-semibold uppercase tracking-[0.2em]">PopAlpha Intelligence</p>
              <p className="mt-3 text-6xl font-semibold leading-none">{grade ?? "Canonical Asset"}</p>
              <p className="mt-5 max-w-[700px] text-3xl font-semibold leading-tight">{title}</p>
            </div>
            <div className="glass w-[230px] rounded-[22px] border-app border p-5 text-center">
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Scarcity score</p>
              <p className="mt-2 text-6xl font-semibold leading-none">{formatNumber(scarcityScore)}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="glass rounded-[18px] border-app border p-5">
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Percent higher</p>
              <p className="mt-2 text-4xl font-semibold">{formatPercent(percentHigher)}</p>
            </div>
            <div className="glass rounded-[18px] border-app border p-5">
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Total population</p>
              <p className="mt-2 text-4xl font-semibold">{formatNumber(totalPop)}</p>
            </div>
            <div className="glass rounded-[18px] border-app border p-5">
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Liquidity tier</p>
              <p className="mt-2 text-3xl font-semibold">{liquidityTier ?? "—"}</p>
            </div>
          </div>

          {isOneOfOne ? (
            <div className="badge-gold inline-flex items-center rounded-full px-5 py-2 text-lg font-semibold">
              🏆 1 of 1
            </div>
          ) : null}
        </div>

        <div className="flex items-end justify-between">
          <p className="text-muted text-sm">Scarcity and grade-distribution intelligence snapshot</p>
          <p className="text-muted text-xl font-semibold tracking-[0.08em]">POPALPHA</p>
        </div>
      </div>
    </article>
  );
}
