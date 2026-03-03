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
    <section className="mt-6 rounded-[var(--radius-card)] border border-[#16311E] bg-[linear-gradient(180deg,rgba(12,38,22,0.94),rgba(9,18,14,0.96))] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="inline-flex items-center rounded-full border border-[rgba(0,220,90,0.24)] bg-[rgba(0,220,90,0.10)] px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.22em] text-[#7DFFAF] sm:text-[13px]">
            PopAlpha Scout
          </div>
          <p className="mt-3 text-sm text-[#8BA292]">Preview only. This is the card-page presentation before live Gemini generation is enabled.</p>
        </div>
      </div>

      <div className="mt-4 rounded-[var(--radius-input)] border border-[rgba(125,255,175,0.12)] bg-[rgba(255,255,255,0.03)] p-4">
        <p className="text-sm leading-7 text-[#E8F5EC]">{summary}</p>
      </div>
    </section>
  );
}
