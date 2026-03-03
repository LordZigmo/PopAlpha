"use client";

import { useState, useTransition } from "react";
import { generateCardAnalysis, type CardAnalysisInput, type CardAnalysisResult } from "@/app/actions/analyze";
import type { PopAlphaTier } from "@/lib/ai/models";

const TIERS: PopAlphaTier[] = ["Trainer", "Ace", "Elite"];

export default function CardAiAnalysis({
  input,
}: {
  input: Omit<CardAnalysisInput, "tier">;
}) {
  const [activeTier, setActiveTier] = useState<PopAlphaTier>("Trainer");
  const [result, setResult] = useState<CardAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runAnalysis(nextTier: PopAlphaTier) {
    setActiveTier(nextTier);
    setError(null);

    startTransition(async () => {
      try {
        const nextResult = await generateCardAnalysis({
          ...input,
          tier: nextTier,
        });
        setResult(nextResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Analysis failed.");
      }
    });
  }

  return (
    <section className="mt-6 rounded-[var(--radius-card)] border-app border bg-surface-soft/20 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-app text-sm font-semibold uppercase tracking-[0.18em]">Hype Engine</h2>
          <p className="text-muted mt-1 text-sm">On-demand AI readouts for this card.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => runAnalysis(tier)}
              disabled={isPending}
              className={`rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold transition ${
                tier === activeTier ? "border-[var(--color-accent)] text-app" : "border-app text-muted"
              }`}
            >
              {tier}
            </button>
          ))}
        </div>
      </div>

      {!result && !error ? (
        <div className="mt-4 rounded-[var(--radius-input)] border-app border bg-surface/20 p-4">
          <p className="text-muted text-sm">Pick a tier to generate a PopAlpha analysis.</p>
        </div>
      ) : null}

      {isPending ? (
        <div className="mt-4 rounded-[var(--radius-input)] border-app border bg-surface/20 p-4">
          <p className="text-muted text-sm">Running {activeTier} analysis...</p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-[var(--radius-input)] border border-[#5a1f1f] bg-[#2a1111] p-4">
          <p className="text-sm text-[#ff8b8b]">{error}</p>
        </div>
      ) : null}

      {result && !isPending ? (
        <div className="mt-4 rounded-[var(--radius-input)] border-app border bg-surface/20 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-app text-xs font-semibold uppercase tracking-[0.16em]">{result.persona}</span>
            <span className="text-muted text-xs">{result.tier}</span>
          </div>
          <p className="text-app whitespace-pre-line text-sm leading-relaxed">{result.text}</p>
        </div>
      ) : null}
    </section>
  );
}
