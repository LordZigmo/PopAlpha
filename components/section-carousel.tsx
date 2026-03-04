import type { ReactNode } from "react";

/**
 * Horizontal scroll carousel for homepage sections.
 * Mobile: CSS-only scroll-snap. Desktop: 5-column grid.
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
    <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        {icon ? <span className="text-lg">{icon}</span> : null}
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-[14px] text-[#8A8A8A]">{subtitle}</span>
        ) : null}
      </div>

      <div
        className="mt-3 flex gap-3 overflow-x-auto px-4 pb-2 sm:px-6 lg:grid lg:grid-cols-5 lg:overflow-visible lg:px-0 lg:pb-0"
        style={{
          scrollSnapType: "x mandatory",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {children}
        {empty ? (
          <div className="flex min-h-[140px] w-full items-center justify-center text-sm text-[#444] lg:col-span-5">
            {empty}
          </div>
        ) : null}
      </div>
    </section>
  );
}
