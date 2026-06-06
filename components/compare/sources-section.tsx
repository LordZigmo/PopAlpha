import type { ComparisonSource } from "@/lib/compare/types";

// External citations for the factual claims on a comparison page — e.g. a
// competitor's own pricing page backing a stated scan-limit figure. Competitor
// links carry rel="nofollow". PopAlpha's English price sourcing is intentionally
// NOT cited here: public copy says "PopAlpha market feeds" per the no-direct-EN-
// sourcing rule (docs/release-handoff-2026-05-28.md). The compliant JP sources are
// cited inline in the methodology block instead.
export default function SourcesSection({ sources }: { sources?: ComparisonSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <section className="mt-16 border-t border-white/[0.06] pt-8">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#8A8A8E]">
        Sources
      </h2>
      <ul className="mt-3 space-y-1.5 text-[14px] leading-6 text-[#8A8A8E]">
        {sources.map((source) => (
          <li key={source.url}>
            <a
              href={source.url}
              target="_blank"
              rel={source.nofollow ? "nofollow noopener noreferrer" : "noopener noreferrer"}
              className="underline decoration-white/20 underline-offset-2 transition hover:text-white hover:decoration-white/60"
            >
              {source.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
