import Link from "next/link";
import { appStoreHref, isAppStoreLive } from "@/lib/marketing/app-store";

type AppStoreBadgeProps = {
  /** Visual scale. `lg` is the hero size. */
  size?: "md" | "lg";
  className?: string;
  /** Optional analytics / scroll source label. */
  "data-cta"?: string;
};

/**
 * Apple "Download on the App Store" badge, rendered as crisp inline SVG so it
 * stays sharp at any size and inherits our dark theme. Destination is driven by
 * `lib/marketing/app-store` — a real apps.apple.com link once live, the waitlist
 * anchor until then.
 */
export default function AppStoreBadge({
  size = "lg",
  className = "",
  ...rest
}: AppStoreBadgeProps) {
  const height = size === "lg" ? 56 : 48;
  const external = isAppStoreLive;

  return (
    <Link
      href={appStoreHref}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      aria-label={external ? "Download PopAlpha on the App Store" : "Join the PopAlpha waitlist for App Store launch"}
      className={`group relative inline-flex items-center gap-3 overflow-hidden rounded-2xl border border-white/15 bg-black px-5 text-white shadow-[0_10px_40px_-12px_rgba(0,0,0,0.9)] transition-all duration-300 hover:border-white/30 hover:shadow-[0_18px_50px_-12px_rgba(0,180,216,0.45)] ${className}`}
      style={{ height }}
      {...rest}
    >
      {/* liquid-glass specular sheen */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0)_42%)] opacity-70"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-10 -top-10 h-16 -rotate-12 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent)] translate-x-[-130%] transition-transform duration-700 group-hover:translate-x-[130%]"
      />

      <svg
        viewBox="0 0 24 24"
        className="relative h-7 w-7 shrink-0 fill-white"
        aria-hidden="true"
      >
        <path d="M17.05 12.04c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.1-2.01-3.77-2.04-1.6-.16-3.13.94-3.94.94-.81 0-2.07-.92-3.4-.9-1.75.03-3.36 1.02-4.26 2.58-1.82 3.16-.47 7.83 1.3 10.39.86 1.25 1.89 2.66 3.24 2.61 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.29-1.28 3.15-2.54.99-1.46 1.4-2.87 1.42-2.94-.03-.01-2.73-1.05-2.76-4.16zM14.5 4.5c.72-.87 1.2-2.08 1.07-3.28-1.03.04-2.28.69-3.02 1.56-.66.77-1.24 2-1.08 3.18 1.15.09 2.32-.59 3.03-1.46z" />
      </svg>

      <span className="relative flex flex-col leading-none">
        <span className="text-[10px] font-medium tracking-wide text-white/70">
          {external ? "Download on the" : "Coming soon to the"}
        </span>
        <span className="text-[19px] font-semibold tracking-[-0.01em]">App Store</span>
      </span>
    </Link>
  );
}
