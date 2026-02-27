"use client";

import { useRef, useState } from "react";
import { toPng } from "html-to-image";
import ShareCard from "@/components/ShareCard";

type ShareIntelligenceButtonProps = {
  title: string;
  grade?: string | null;
  scarcityScore?: number | null;
  percentHigher?: number | null;
  totalPop?: number | null;
  isOneOfOne?: boolean;
  liquidityTier?: string | null;
  fileName: string;
};

export default function ShareIntelligenceButton({
  title,
  grade,
  scarcityScore,
  percentHigher,
  totalPop,
  isOneOfOne = false,
  liquidityTier,
  fileName,
}: ShareIntelligenceButtonProps) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  async function handleDownload() {
    if (!cardRef.current) return;
    setDownloading(true);
    setError(null);
    try {
      const dataUrl = await toPng(cardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        width: 1200,
        height: 630,
      });
      const link = document.createElement("a");
      link.download = fileName.endsWith(".png") ? fileName : `${fileName}.png`;
      link.href = dataUrl;
      link.click();
    } catch {
      setError("Could not generate image.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold"
      >
        Share
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="glass w-full max-w-5xl rounded-[var(--radius-panel)] border-app border p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-app text-sm font-semibold uppercase tracking-[0.14em]">Share Intelligence Card</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost rounded-[var(--radius-input)] border px-2 py-1 text-xs"
              >
                Close
              </button>
            </div>

            <div className="mt-3 overflow-auto rounded-[var(--radius-card)] border-app border bg-surface-soft/60 p-2">
              <div className="min-w-[920px] origin-top-left scale-[0.75] sm:scale-[0.8] md:scale-[0.86] lg:scale-[0.92] xl:scale-100">
                <div ref={cardRef}>
                  <ShareCard
                    title={title}
                    grade={grade}
                    scarcityScore={scarcityScore}
                    percentHigher={percentHigher}
                    totalPop={totalPop}
                    isOneOfOne={isOneOfOne}
                    liquidityTier={liquidityTier}
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-muted text-xs">{error ?? "Exports as 1200x630 PNG."}</p>
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={downloading}
                className="btn-accent rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
              >
                {downloading ? "Generating..." : "Download Image"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
