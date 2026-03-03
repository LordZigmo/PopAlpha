import type { ReactNode } from "react";

/**
 * Horizontal scroll carousel for homepage sections.
 * CSS-only scroll-snap for SSR compatibility — no client JS.
 */
export default function SectionCarousel({
  title,
  subtitle,
  icon,
  children,
  empty,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-2 px-4 sm:px-6">
        {icon ? <span className="text-base">{icon}</span> : null}
        <h2 className="text-[15px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-[13px] text-[#444]">{subtitle}</span>
        ) : null}
      </div>

      <div
        className="mt-3 flex gap-3 overflow-x-auto px-4 pb-2 sm:px-6"
        style={{
          scrollSnapType: "x mandatory",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {children}
        {empty ? (
          <div className="flex min-h-[140px] w-full items-center justify-center text-sm text-[#444]">
            {empty}
          </div>
        ) : null}
      </div>
    </section>
  );
}
