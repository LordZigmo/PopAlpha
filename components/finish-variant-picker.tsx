"use client";

import type { FinishGroup } from "@/lib/cards/detail-types";

type Tone = "primary" | "secondary";

type FinishVariantPickerProps = {
  finishGroups: FinishGroup[];
  selectedPrintingId: string | null;
  onChange: (printingId: string) => void;
  className?: string;
};

function pillClass(active: boolean, tone: Tone): string {
  const base =
    "inline-flex min-h-10 items-center rounded-full border px-3 text-[14px] font-semibold transition-all duration-150";
  if (tone === "primary") {
    return active
      ? `${base} border-white/[0.1] bg-[#222] text-[#F0F0F0] shadow-[0_2px_8px_rgba(0,0,0,0.2)]`
      : `${base} border-white/[0.04] bg-transparent text-[#888]`;
  }
  return active
    ? `${base} border-white/[0.08] bg-[#1A1A1A] text-[#EDEDED] min-h-9 text-[13px]`
    : `${base} border-white/[0.03] bg-transparent text-[#666] min-h-9 text-[13px]`;
}

function findActiveGroup(
  finishGroups: FinishGroup[],
  selectedPrintingId: string | null,
): FinishGroup | null {
  if (!selectedPrintingId) return finishGroups[0] ?? null;
  for (const group of finishGroups) {
    if (group.variants.some((variant) => variant.printingId === selectedPrintingId)) {
      return group;
    }
  }
  return finishGroups[0] ?? null;
}

export default function FinishVariantPicker({
  finishGroups,
  selectedPrintingId,
  onChange,
  className,
}: FinishVariantPickerProps) {
  if (finishGroups.length === 0) return null;
  if (finishGroups.length === 1 && finishGroups[0].variants.length <= 1) return null;

  const activeGroup = findActiveGroup(finishGroups, selectedPrintingId);
  const showSecondary = !!activeGroup && activeGroup.variants.length > 1;

  return (
    <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>
      <div className="flex flex-wrap gap-2">
        {finishGroups.map((group) => {
          const isActive = activeGroup?.finish === group.finish;
          return (
            <button
              key={group.finish}
              type="button"
              className={pillClass(isActive, "primary")}
              onClick={() => onChange(group.defaultPrintingId)}
            >
              {group.finishLabel}
            </button>
          );
        })}
      </div>
      {showSecondary && activeGroup ? (
        <div className="flex flex-wrap gap-1.5 pl-1">
          {activeGroup.variants.map((variant) => {
            const isActive = variant.printingId === selectedPrintingId;
            return (
              <button
                key={variant.printingId}
                type="button"
                className={pillClass(isActive, "secondary")}
                onClick={() => onChange(variant.printingId)}
              >
                {variant.stampLabel}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
