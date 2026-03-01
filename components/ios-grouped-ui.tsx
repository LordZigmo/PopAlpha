/**
 * README
 * Primitives: PageShell, NavBar, GroupedSection, GroupCard, StatRow, StatTile, SegmentedControl, Pill, Skeleton.
 * Layout: sticky top navigation, compact identity header, grouped filter controls, primary signal tiles, then grouped snapshot dashboards stacked for mobile-first scanning.
 * iOS grouped rules: matte dark surfaces, shared radius/border/padding, subtle hairline separators, 44px+ controls, and explicit variants instead of one-off styles.
 */
import type { ReactNode } from "react";
import Link from "next/link";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type Tone = "neutral" | "positive" | "negative" | "warning";

const PILL_TONE_CLASS: Record<Tone, string> = {
  neutral: "border-[#1E1E1E] bg-white/[0.04] text-[#999]",
  positive: "border-[#00DC5A]/20 bg-[#00DC5A]/[0.08] !text-[#00DC5A]",
  negative: "border-[#FF3B30]/20 bg-[#FF3B30]/[0.08] !text-[#FF3B30]",
  warning: "border-amber-400/20 bg-amber-400/[0.08] !text-amber-200",
};

const TILE_TONE_CLASS: Record<Tone, string> = {
  neutral: "",
  positive: "border-[#00DC5A]/18 bg-[#00DC5A]/[0.06]",
  negative: "border-[#FF3B30]/18 bg-[#FF3B30]/[0.06]",
  warning: "border-amber-400/18 bg-amber-400/[0.06]",
};

const TILE_VALUE_TONE_CLASS: Record<Tone, string> = {
  neutral: "text-[#F0F0F0]",
  positive: "!text-[#00DC5A]",
  negative: "!text-[#FF3B30]",
  warning: "!text-amber-200",
};

const TILE_LABEL_TONE_CLASS: Record<Tone, string> = {
  neutral: "text-[#6B6B6B]",
  positive: "!text-[#00DC5A]",
  negative: "!text-[#FF3B30]",
  warning: "!text-amber-200",
};

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <div className="min-h-screen">{children}</div>
    </main>
  );
}

export function NavBar({
  title,
  subtitle,
  compact = false,
  backHref = "/search",
}: {
  title: string;
  subtitle?: string;
  compact?: boolean;
  backHref?: string;
}) {
  const showIdentity = Boolean(title || subtitle);
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[#1E1E1E]",
        compact ? "bg-[#0A0A0Af2]" : "bg-[#0A0A0Acc]"
      )}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
        <Link
          href={backHref}
          aria-label="Back"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#1E1E1E] bg-[#111111] text-[#999]"
        >
          <span className="text-[26px] leading-none">‹</span>
        </Link>
        {showIdentity ? (
          <div className="min-w-0 flex-1">
            {title ? (
              <p className={cn("truncate font-semibold tracking-[-0.02em]", compact ? "text-[15px]" : "text-[17px]")}>{title}</p>
            ) : null}
            {subtitle ? <p className="truncate text-[12px] text-[#6B6B6B]">{subtitle}</p> : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function GroupedSection({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-6", className)}>
      {title || description ? (
        <div className="mb-2 px-1">
          {title ? <p className="text-[14px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">{title}</p> : null}
          {description ? <p className="mt-1 text-[14px] text-[#555]">{description}</p> : null}
        </div>
      ) : null}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function GroupCard({
  children,
  header,
  inset = false,
  className,
}: {
  children: ReactNode;
  header?: ReactNode;
  inset?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden border border-[#1E1E1E] bg-[#111111] shadow-[0_12px_32px_rgba(0,0,0,0.25)]",
        inset ? "rounded-2xl bg-[#1A1A1A]" : "rounded-[20px]",
        className
      )}
    >
      {header ? <div className="border-b border-[#1E1E1E] px-5 py-3">{header}</div> : null}
      <div className={cn(inset ? "p-4" : "p-5 sm:p-6")}>{children}</div>
    </div>
  );
}

export function Pill({
  label,
  tone = "neutral",
  size = "default",
}: {
  label: string;
  tone?: Tone;
  size?: "default" | "small";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-semibold",
        size === "small" ? "min-h-6 px-2.5 text-[12px]" : "min-h-7 px-3 text-[13px]",
        PILL_TONE_CLASS[tone]
      )}
    >
      {label}
    </span>
  );
}

export function Skeleton({
  className,
  rounded = "full",
}: {
  className?: string;
  rounded?: "full" | "card";
}) {
  return (
    <div
      className={cn(
        "animate-pulse bg-white/[0.06]",
        rounded === "card" ? "rounded-2xl" : "rounded-full",
        className
      )}
    />
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
      detail?: ReactNode;
  tone?: Tone;
}) {
  return (
    <GroupCard inset className={TILE_TONE_CLASS[tone]}>
      <p className={cn("text-[13px] font-semibold uppercase tracking-[0.08em]", TILE_LABEL_TONE_CLASS[tone])}>{label}</p>
      <div className={cn("mt-2 text-[26px] font-semibold tracking-[-0.03em]", TILE_VALUE_TONE_CLASS[tone])}>{value}</div>
      {detail ? <div className="mt-3">{typeof detail === "string" ? <Pill label={detail} tone={tone} size="small" /> : detail}</div> : null}
    </GroupCard>
  );
}

export function StatRow({
  label,
  value,
  meta,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-[16px] text-[#D0D0D0]">{label}</p>
        {meta ? (
          <div className="mt-1 text-[13px] text-[#6B6B6B]">{typeof meta === "string" ? <Pill label={meta} tone={tone} size="small" /> : meta}</div>
        ) : null}
      </div>
      <div className="shrink-0 text-right text-[16px] font-semibold text-[#F0F0F0]">{value}</div>
    </div>
  );
}

export function StatStripItem({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="inline-flex flex-col">
      <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#6B6B6B]">{label}</p>
      <p className={cn("mt-0.5 text-[18px] font-bold tabular-nums tracking-[-0.02em]", TILE_VALUE_TONE_CLASS[tone])}>{value}</p>
    </div>
  );
}

export function SegmentedControl({
  items,
  wrap = false,
}: {
  items: Array<{ key: string; label: string; href?: string; active?: boolean; disabled?: boolean }>;
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-[#1E1E1E] bg-[#0D0D0D] p-1",
        wrap ? "flex flex-wrap gap-1.5" : "grid auto-cols-fr grid-flow-col gap-1"
      )}
    >
      {items.map((item) => {
        const className = cn(
          "flex min-h-11 items-center justify-center rounded-xl px-3 text-center text-[14px] font-semibold transition",
          item.active
            ? "bg-[#222222] text-[#F0F0F0] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            : "text-[#6B6B6B]",
          item.disabled && "cursor-default opacity-60",
          wrap && "min-w-fit"
        );

        if (!item.href || item.disabled) {
          return (
            <span key={item.key} className={className}>
              {item.label}
            </span>
          );
        }

        return (
          <Link key={item.key} href={item.href} className={className}>
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
