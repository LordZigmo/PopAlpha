"use client";

import { useMemo, useState } from "react";

function buildPreviewText(paragraphs: string[]): string {
  const combined = paragraphs.join(" ").replace(/\s+/g, " ").trim();
  if (combined.length <= 200) return combined;

  const sentenceMatches = combined.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];

  if (sentenceMatches.length >= 2) {
    const firstTwo = `${sentenceMatches[0]} ${sentenceMatches[1]}`.trim();
    if (firstTwo.length <= 220) {
      return firstTwo;
    }
  }

  const clipped = combined.slice(0, 210);
  const lastSpace = clipped.lastIndexOf(" ");
  const safeClip = lastSpace > 120 ? clipped.slice(0, lastSpace) : clipped;
  return `${safeClip.trim()}...`;
}

export default function ExpandableInsight({
  text,
  className = "",
  fadeOverlayClassName,
  blurOverlayClassName,
  showBlurOverlay = true,
}: {
  text: string;
  className?: string;
  fadeOverlayClassName?: string;
  blurOverlayClassName?: string;
  showBlurOverlay?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const paragraphs = useMemo(
    () => text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    [text],
  );
  const previewText = useMemo(() => buildPreviewText(paragraphs), [paragraphs]);
  const showCollapsedPreview = previewText.length > 0 && previewText !== paragraphs.join(" ").replace(/\s+/g, " ").trim();

  return (
    <div>
      <div className="relative">
        {expanded || !showCollapsedPreview ? (
          <div className={className}>
            {paragraphs.map((paragraph, index) => (
              <p key={`expandable-insight-${index}`}>{paragraph}</p>
            ))}
          </div>
        ) : (
          <>
            <p className={className}>{previewText}</p>
            <div
              className={[
                "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#0A0A0A] via-[#0A0A0A]/88 to-transparent",
                fadeOverlayClassName ?? "",
              ].join(" ")}
            />
            {showBlurOverlay && blurOverlayClassName ? (
              <div
                className={[
                  "pointer-events-none absolute inset-x-0 bottom-0 h-10 backdrop-blur-[3px]",
                  blurOverlayClassName,
                ].join(" ")}
              />
            ) : null}
          </>
        )}
      </div>

      {showCollapsedPreview ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-3 inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-white/[0.08]"
        >
          {expanded ? "See Less" : "See More"}
        </button>
      ) : null}
    </div>
  );
}
