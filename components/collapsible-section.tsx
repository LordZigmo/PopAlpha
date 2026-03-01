"use client";

import { useState } from "react";
import type { ReactNode } from "react";

type CollapsibleSectionProps = {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
};

export default function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = false,
  badge,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#1E1E1E] bg-[#111111] px-5 py-3.5 text-left transition hover:bg-[#151515]"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <p className="text-[17px] font-semibold text-[#F0F0F0] truncate">{title}</p>
          {badge}
          {subtitle && (
            <p className="text-[14px] text-[#6B6B6B] truncate hidden sm:block">{subtitle}</p>
          )}
        </div>
        <svg
          viewBox="0 0 20 20"
          className={`collapsible-chevron h-5 w-5 shrink-0 fill-[#6B6B6B] ${open ? "rotate-180" : ""}`}
        >
          <path d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" />
        </svg>
      </button>
      <div className="collapsible-content grid" style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className="pt-3">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
