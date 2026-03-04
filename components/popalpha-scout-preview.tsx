import { Sparkles } from "lucide-react";
import { buildPopAlphaScoutSummary } from "@/lib/ai/scout-summary";

type PopAlphaScoutPreviewProps = {
  cardName: string;
  marketPrice: number | null;
  fairValue: number | null;
  changePct: number | null;
  changeLabel: "24h" | "7d" | null;
  activeListings7d: number | null;
  summaryText?: string | null;
};

export default function PopAlphaScoutPreview(props: PopAlphaScoutPreviewProps) {
  const summary = props.summaryText?.trim()
    || buildPopAlphaScoutSummary({
      cardName: props.cardName,
      marketPrice: props.marketPrice,
      fairValue: props.fairValue,
      changePct: props.changePct,
      changeLabel: props.changeLabel,
      activeListings7d: props.activeListings7d,
    }).summaryLong;

  return (
    <section className="relative mt-6 overflow-hidden rounded-2xl border border-[#63D471]/25 border-l-4 border-l-emerald-500 bg-emerald-500/10 px-4 py-3 shadow-[0_0_28px_rgba(16,185,129,0.20),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-md">
      <span className="pointer-events-none absolute inset-y-0 -left-1 w-1/2 scout-holo-shimmer" aria-hidden="true" />
      <div className="relative z-10 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[30px] font-semibold tracking-[-0.03em] text-emerald-400 sm:text-[32px]">
            <Sparkles size={14} strokeWidth={2.2} className="text-emerald-300" />
            PopAlpha Scout
          </div>
          <p className="mt-1 text-[12px] font-medium tracking-[0.04em] text-emerald-200/85 sm:text-[13px]">
            Pokemon-obsessed AI
          </p>
        </div>
        <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-red-500/20 bg-red-500/10 px-3 text-[18px] font-semibold leading-none tracking-[-0.01em] text-red-100">
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-red-500 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
          </span>
          Live
        </span>
      </div>

      <p className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-emerald-50 sm:text-[19px]">
        {summary}
      </p>
    </section>
  );
}
