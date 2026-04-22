"use client";

import { useEffect, useState } from "react";
import { Compass } from "lucide-react";

import TypewriterText from "@/components/typewriter-text";
import type { PersonalizedExplanation } from "@/lib/personalization/types";

type ProfileSummary = {
  dominant_style_label: string;
  supporting_traits: string[];
  confidence: number;
  event_count: number;
} | null;

type ApiResponse = {
  ok: boolean;
  enabled?: boolean;
  mode?: "template" | "llm";
  explanation?: PersonalizedExplanation | null;
  profile_summary?: ProfileSummary;
};

type Props = {
  canonicalSlug: string;
  variantRef?: string | null;
};

function formatUpdatedAgo(value: string | null | undefined): string {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fitsLabel(fits: PersonalizedExplanation["fits"] | undefined): string {
  if (fits === "aligned") return "Your style";
  if (fits === "contrast") return "Off pattern";
  return "Your style";
}

export default function PersonalizedCardInsight({ canonicalSlug, variantRef }: Props) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "disabled" }
    | { kind: "error"; error: string }
    | { kind: "ready"; data: ApiResponse }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const url = new URL("/api/personalization/explanation", window.location.origin);
        url.searchParams.set("slug", canonicalSlug);
        if (variantRef) url.searchParams.set("variant_ref", variantRef);
        const res = await fetch(url.toString(), {
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = (await res.json()) as ApiResponse;
        if (cancelled) return;
        if (!data.ok || data.enabled === false) {
          setState({ kind: "disabled" });
          return;
        }
        setState({ kind: "ready", data });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: "error", error: err instanceof Error ? err.message : "load failed" });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [canonicalSlug, variantRef]);

  if (state.kind === "disabled") return null;
  if (state.kind === "error") return null;

  const explanation = state.kind === "ready" ? state.data.explanation ?? null : null;
  const profileSummary = state.kind === "ready" ? state.data.profile_summary ?? null : null;
  const isLoading = state.kind === "loading";
  const updatedAgo = formatUpdatedAgo(explanation?.generated_at);

  const summary = explanation?.summary
    ?? (isLoading ? "Reading your activity…" : "We'll learn your collecting style as you browse.");

  const confidencePct = profileSummary?.confidence != null
    ? Math.round(profileSummary.confidence * 100)
    : null;

  const fits = explanation?.fits ?? "neutral";
  const badgeLabel = fitsLabel(fits);

  return (
    <section
      aria-labelledby="personalized-insight-heading"
      className="relative mt-6 overflow-hidden rounded-2xl border border-[rgba(192,132,252,0.35)] border-l-4 border-l-[#A855F7] bg-[rgba(168,85,247,0.12)] px-4 py-3 shadow-[0_0_28px_rgba(168,85,247,0.28),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-md"
    >
      <span
        className="pointer-events-none absolute inset-y-0 -left-1 w-1/2 personalized-holo-shimmer"
        aria-hidden="true"
      />
      <div className="relative z-10 flex items-start justify-between gap-4">
        <div>
          <div
            id="personalized-insight-heading"
            className="flex items-center gap-2 text-[30px] font-semibold tracking-[-0.03em] text-[#D8B4FE] sm:text-[32px]"
          >
            <Compass size={14} strokeWidth={2.2} className="text-[#E9D5FF]" />
            How this fits your style
          </div>
          <p className="mt-1 text-[12px] font-medium tracking-[0.04em] text-[rgba(233,213,255,0.85)] sm:text-[13px]">
            Personalized for you
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="inline-flex h-[2.25rem] items-center gap-2 self-start rounded-full border border-[rgba(192,132,252,0.45)] bg-[rgba(168,85,247,0.28)] px-3 text-[14px] font-semibold leading-none tracking-[-0.01em] text-[#F5F3FF]">
            {badgeLabel}
          </span>
          {confidencePct != null ? (
            <span className="mt-1 pr-1 text-[11px] font-medium tracking-[0.04em] text-[rgba(233,213,255,0.75)]">
              {confidencePct}% signal · {updatedAgo}
            </span>
          ) : (
            <span className="mt-1 pr-1 text-[11px] font-medium tracking-[0.04em] text-[rgba(233,213,255,0.75)]">
              {updatedAgo}
            </span>
          )}
        </div>
      </div>

      <TypewriterText
        text={summary}
        className="relative z-10 mt-2 text-[18px] font-medium leading-relaxed text-[#F5F3FF] sm:text-[19px]"
      />

      {explanation?.reasons && explanation.reasons.length > 0 ? (
        <ul className="relative z-10 mt-3 space-y-1.5">
          {explanation.reasons.map((reason, idx) => (
            <li
              key={idx}
              className="relative pl-4 text-[14px] leading-relaxed text-[rgba(237,225,254,0.92)] before:absolute before:left-0 before:top-[0.55em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-[rgba(192,132,252,0.8)]"
            >
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      {explanation?.caveats && explanation.caveats.length > 0 ? (
        <p className="relative z-10 mt-3 text-[11px] italic text-[rgba(233,213,255,0.6)]">
          {explanation.caveats.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
