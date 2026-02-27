"use client";

import { useState } from "react";
import type { Root } from "react-dom/client";
import ShareCard from "@/components/ShareCard";

type ShareIntelligenceButtonProps = {
  title: string;
  grade?: string | null;
  scarcityScore?: number | null;
  percentHigher?: number | null;
  populationHigher?: number | null;
  totalPop?: number | null;
  isOneOfOne?: boolean;
  liquidityTier?: string | null;
  imageUrl?: string | null;
  fileName: string;
};

export default function ShareIntelligenceButton({
  title,
  grade,
  scarcityScore,
  percentHigher,
  populationHigher,
  totalPop,
  isOneOfOne = false,
  liquidityTier,
  imageUrl,
  fileName,
}: ShareIntelligenceButtonProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<"square" | "landscape" | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string; mode?: "square" | "landscape" } | null>(null);

  async function renderAndExport(mode: "square" | "landscape") {
    const target = mode === "square" ? { width: 1080, height: 1080 } : { width: 1200, height: 630 };
    setExporting(mode);
    setToast(null);
    let mount: HTMLDivElement | null = null;
    let exportRoot: Root | null = null;
    try {
      if ("fonts" in document && typeof document.fonts.ready?.then === "function") {
        await document.fonts.ready;
      }

      const { toPng } = await import("html-to-image");

      mount = document.createElement("div");
      mount.style.position = "fixed";
      mount.style.left = "-99999px";
      mount.style.top = "0";
      mount.style.width = `${target.width}px`;
      mount.style.height = `${target.height}px`;
      mount.style.pointerEvents = "none";
      mount.style.zIndex = "-1";
      document.body.appendChild(mount);

      const root = document.createElement("div");
      root.style.width = "100%";
      root.style.height = "100%";
      mount.appendChild(root);

      const { createRoot } = await import("react-dom/client");
      exportRoot = createRoot(root);
      exportRoot.render(
        <ShareCard
          title={title}
          grade={grade}
          scarcityScore={scarcityScore}
          percentHigher={percentHigher}
          populationHigher={populationHigher}
          totalPop={totalPop}
          isOneOfOne={isOneOfOne}
          liquidityTier={liquidityTier}
          imageUrl={imageUrl}
          mode={mode}
        />
      );

      await new Promise((resolve) => window.setTimeout(resolve, 24));

      const dataUrl = await toPng(root, {
        cacheBust: true,
        pixelRatio: 1,
        width: target.width,
        height: target.height,
      });

      const link = document.createElement("a");
      const base = fileName.replace(/\.png$/i, "");
      link.download = `${base}-${mode}.png`;
      link.href = dataUrl;
      link.click();
      setToast({ kind: "success", message: "Image downloaded.", mode });
    } catch {
      setToast({ kind: "error", message: "Could not generate image. Try again.", mode });
    } finally {
      if (exportRoot) exportRoot.unmount();
      if (mount) mount.remove();
      setExporting(null);
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-3 sm:p-4">
          <div className="glass w-full max-w-3xl rounded-[var(--radius-panel)] border-app border p-4 sm:p-5">
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

            <div className="mt-3 rounded-[var(--radius-card)] border-app border bg-surface-soft/60 p-2">
              <div className="mx-auto aspect-square w-[min(100%,62vh)] max-w-[620px]">
                <ShareCard
                  title={title}
                  grade={grade}
                  scarcityScore={scarcityScore}
                  percentHigher={percentHigher}
                  populationHigher={populationHigher}
                  totalPop={totalPop}
                  isOneOfOne={isOneOfOne}
                  liquidityTier={liquidityTier}
                  imageUrl={imageUrl}
                  mode="square"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted text-xs">Square preview shown by default.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void renderAndExport("square")}
                  disabled={exporting !== null}
                  className="btn-accent rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  {exporting === "square" ? "Generating..." : "Download Square (1080×1080)"}
                </button>
                <button
                  type="button"
                  onClick={() => void renderAndExport("landscape")}
                  disabled={exporting !== null}
                  className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  {exporting === "landscape" ? "Generating..." : "Download Landscape (1200×630)"}
                </button>
              </div>
            </div>

            {toast ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className={`text-xs ${toast.kind === "success" ? "text-positive" : "text-negative"}`}>{toast.message}</p>
                {toast.kind === "error" && toast.mode ? (
                  <button
                    type="button"
                    onClick={() => void renderAndExport(toast.mode as "square" | "landscape")}
                    className="btn-ghost rounded-[var(--radius-input)] border px-2 py-1 text-xs"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
