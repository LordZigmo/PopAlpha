"use client";

type ViewHistoryPoint = {
  date: string;
  views: number;
};

type ViewHistoryChartProps = {
  points: ViewHistoryPoint[];
};

function formatDayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export default function ViewHistoryChart({ points }: ViewHistoryChartProps) {
  const highest = Math.max(...points.map((point) => point.views), 1);
  const startLabel = points[0] ? formatDayLabel(points[0].date) : null;
  const endLabel = points[points.length - 1] ? formatDayLabel(points[points.length - 1].date) : null;

  return (
    <div>
      <div className="flex h-28 items-end gap-1.5 rounded-2xl border border-white/[0.04] bg-[#0B0B0B] px-3 py-3 sm:h-32">
        {points.map((point, index) => {
          const height = Math.max((point.views / highest) * 100, point.views > 0 ? 10 : 3);
          const isLatest = index === points.length - 1;
          return (
            <div key={`${point.date}-${index}`} className="flex h-full flex-1 items-end">
              <div
                className="w-full rounded-t-[10px] transition-[height,background-color] duration-300"
                style={{
                  height: `${height}%`,
                  backgroundColor: isLatest ? "#F5F5F5" : point.views > 0 ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.08)",
                }}
                title={`${formatDayLabel(point.date)}: ${point.views} views`}
              />
            </div>
          );
        })}
      </div>
      {startLabel && endLabel ? (
        <div className="mt-2 flex items-center justify-between text-[12px] font-medium uppercase tracking-[0.08em] text-[#555]">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
