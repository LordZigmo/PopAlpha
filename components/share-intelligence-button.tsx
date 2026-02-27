"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type ToastState = {
  kind: "success" | "error";
  message: string;
  mode?: "square" | "landscape";
};

const SQUARE_SIZE = 1080;

function isIosSafariLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(ad|hone|od)/i.test(navigator.userAgent);
}

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
  const [busy, setBusy] = useState<null | "share" | "download-square" | "download-landscape">(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [supportsFileShare, setSupportsFileShare] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const squareFrameRef = useRef<HTMLDivElement | null>(null);

  const baseName = useMemo(() => fileName.replace(/\.png$/i, ""), [fileName]);

  useEffect(() => {
    if (!open || !viewportRef.current) return;
    const node = viewportRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      const scale = Math.min(width / SQUARE_SIZE, height / SQUARE_SIZE, 1);
      setPreviewScale(scale);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open || typeof navigator === "undefined") return;
    const canShareFn = navigator.canShare;
    if (!canShareFn) {
      setSupportsFileShare(false);
      return;
    }
    try {
      const probe = new File([new Blob(["x"], { type: "image/png" })], "probe.png", { type: "image/png" });
      setSupportsFileShare(Boolean(canShareFn({ files: [probe] })));
    } catch {
      setSupportsFileShare(false);
    }
  }, [open]);

  async function ensureFontsReady() {
    if ("fonts" in document && typeof document.fonts.ready?.then === "function") {
      await document.fonts.ready;
    }
  }

  async function blobFromNode(node: HTMLElement, width: number, height: number): Promise<Blob> {
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(node, {
      cacheBust: true,
      pixelRatio: 1,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
    });
    if (!blob) throw new Error("Unable to generate image blob.");
    return blob;
  }

  async function getSquareBlobFromPreview(): Promise<Blob> {
    if (!squareFrameRef.current) throw new Error("Preview frame unavailable.");
    await ensureFontsReady();
    return blobFromNode(squareFrameRef.current, SQUARE_SIZE, SQUARE_SIZE);
  }

  async function getLandscapeBlobFromClone(): Promise<Blob> {
    let mount: HTMLDivElement | null = null;
    let exportRoot: Root | null = null;
    try {
      await ensureFontsReady();
      mount = document.createElement("div");
      mount.style.position = "fixed";
      mount.style.left = "-99999px";
      mount.style.top = "0";
      mount.style.width = "1200px";
      mount.style.height = "630px";
      mount.style.pointerEvents = "none";
      mount.style.zIndex = "-1";
      document.body.appendChild(mount);

      const root = document.createElement("div");
      root.style.width = "1200px";
      root.style.height = "630px";
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
          mode="landscape"
        />
      );
      await new Promise((resolve) => window.setTimeout(resolve, 24));
      return blobFromNode(root, 1200, 630);
    } finally {
      if (exportRoot) exportRoot.unmount();
      if (mount) mount.remove();
    }
  }

  function downloadBlob(blob: Blob, outName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = outName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  async function openBlobForIosLongPress(blob: Blob) {
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function handleDownload(mode: "square" | "landscape") {
    setBusy(mode === "square" ? "download-square" : "download-landscape");
    setToast(null);
    try {
      const blob = mode === "square" ? await getSquareBlobFromPreview() : await getLandscapeBlobFromClone();
      const outName = `${baseName}-${mode}.png`;
      if (isIosSafariLike() && mode === "square") {
        await openBlobForIosLongPress(blob);
        setToast({ kind: "success", message: "Opened image in a new tab. Long-press to Save Image." });
      } else {
        downloadBlob(blob, outName);
        setToast({ kind: "success", message: "Image downloaded.", mode });
      }
    } catch {
      setToast({ kind: "error", message: "Could not generate image. Try again.", mode });
    } finally {
      setBusy(null);
    }
  }

  async function handleShareSave() {
    setBusy("share");
    setToast(null);
    try {
      const blob = await getSquareBlobFromPreview();
      const file = new File([blob], `${baseName}-square.png`, { type: "image/png" });
      if (supportsFileShare && navigator.share) {
        await navigator.share({
          files: [file],
          title: "PopAlpha",
          text: "PopAlpha cert recap",
        });
        setToast({ kind: "success", message: "Share sheet opened." });
      } else if (isIosSafariLike()) {
        await openBlobForIosLongPress(blob);
        setToast({ kind: "success", message: "Opened image in a new tab. Long-press to Save Image." });
      } else {
        downloadBlob(blob, `${baseName}-square.png`);
        setToast({ kind: "success", message: "Image downloaded." });
      }
    } catch {
      setToast({ kind: "error", message: "Could not share image. Try Download PNG.", mode: "square" });
    } finally {
      setBusy(null);
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
              <div ref={viewportRef} className="mx-auto h-[62vh] max-h-[640px] w-full max-w-[640px] overflow-hidden">
                <div
                  style={{
                    width: `${SQUARE_SIZE * previewScale}px`,
                    height: `${SQUARE_SIZE * previewScale}px`,
                  }}
                >
                  <div style={{ width: `${SQUARE_SIZE}px`, height: `${SQUARE_SIZE}px`, transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
                    <div ref={squareFrameRef} style={{ width: `${SQUARE_SIZE}px`, height: `${SQUARE_SIZE}px` }}>
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
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted text-xs">Square preview is rendered from the export frame.</p>
              <div className="flex flex-wrap items-center gap-2">
                {supportsFileShare ? (
                  <button
                    type="button"
                    onClick={() => void handleShareSave()}
                    disabled={busy !== null}
                    className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                  >
                    {busy === "share" ? "Preparing..." : "Share / Save"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleDownload("square")}
                  disabled={busy !== null}
                  className="btn-accent rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  {busy === "download-square" ? "Generating..." : "Download PNG"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDownload("landscape")}
                  disabled={busy !== null}
                  className="btn-ghost rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  {busy === "download-landscape" ? "Generating..." : "Download Landscape (1200x630)"}
                </button>
              </div>
            </div>

            {process.env.NODE_ENV !== "production" ? (
              <p className="mt-2 text-[11px] text-muted">debug: square frame {SQUARE_SIZE}x{SQUARE_SIZE}, scale {previewScale.toFixed(3)}</p>
            ) : null}

            {toast ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className={`text-xs ${toast.kind === "success" ? "text-positive" : "text-negative"}`}>{toast.message}</p>
                {toast.kind === "error" && toast.mode ? (
                  <button
                    type="button"
                    onClick={() => void handleDownload(toast.mode as "square" | "landscape")}
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
