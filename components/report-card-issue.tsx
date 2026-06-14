"use client";

/**
 * Report-a-bug — parity with the native iOS card-issue control. Analytics-only,
 * mirroring iOS: fires a PostHog `bug_reported` capture with the card context.
 * No backend write (no card-issue table/route exists; matches iOS behavior).
 */
import { useState } from "react";
import posthog from "posthog-js";

const CATEGORIES = [
  { key: "wrong_price", label: "Wrong price" },
  { key: "wrong_metadata", label: "Wrong card info" },
  { key: "other", label: "Something else" },
] as const;

export default function ReportCardIssue({
  canonicalSlug,
  cardName,
  setName,
  cardNumber,
}: {
  canonicalSlug: string;
  cardName: string;
  setName: string | null;
  cardNumber: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  function submit(category: string) {
    try {
      // Match the native iOS bug_reported keys (slug / set_name / card_number /
      // source: "card_detail") so web + iOS submissions land in the same
      // PostHog insight; platform stays distinguishable via posthog's $lib.
      posthog.capture("bug_reported", {
        category,
        slug: canonicalSlug,
        card_name: cardName,
        set_name: setName,
        card_number: cardNumber,
        source: "card_detail",
      });
    } catch {
      /* analytics is best-effort */
    }
    setSent(true);
    setOpen(false);
  }

  if (sent) {
    return (
      <p className="mt-8 text-center text-[14px] text-[#6B6B6B]">
        Thanks — report sent.
      </p>
    );
  }

  if (!open) {
    return (
      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[14px] font-medium text-[#6B6B6B] transition hover:text-[#999]"
        >
          Report an issue with this card
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-2xl border border-white/[0.06] bg-[#111111] p-4">
      <p className="mb-3 text-center text-[14px] text-[#999]">What looks wrong?</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {CATEGORIES.map((category) => (
          <button
            key={category.key}
            type="button"
            onClick={() => submit(category.key)}
            className="flex-1 rounded-xl border border-[#1E1E1E] bg-[#151515] px-4 py-3 text-[14px] font-semibold text-[#AAA] transition hover:border-[#333] hover:text-[#F0F0F0]"
          >
            {category.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-3 w-full text-center text-[13px] text-[#555] hover:text-[#777]"
      >
        Cancel
      </button>
    </div>
  );
}
