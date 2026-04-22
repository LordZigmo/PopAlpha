import Link from "next/link";
import { Activity, Layers3, LineChart, Search, Sparkles, Star } from "lucide-react";

type ShortcutItem = {
  href: string;
  label: string;
  description: string;
  icon: typeof Layers3;
};

const SHORTCUTS: ShortcutItem[] = [
  {
    href: "/search",
    label: "Search",
    description: "Find any card by name or set",
    icon: Search,
  },
  {
    href: "/sets",
    label: "Sets",
    description: "Browse by release",
    icon: Layers3,
  },
  {
    href: "/portfolio",
    label: "Portfolio",
    description: "Track your holdings",
    icon: LineChart,
  },
  {
    href: "/watchlist",
    label: "Watchlist",
    description: "Cards you're following",
    icon: Star,
  },
  {
    href: "/activity",
    label: "Activity",
    description: "What your network is up to",
    icon: Activity,
  },
];

/**
 * Default right-rail content used across browsing pages that don't supply
 * their own rail. Keeps chrome consistent and gives the 30% column a
 * purpose until pages supply richer content.
 */
export default function GenericRightRail() {
  return (
    <div className="flex flex-col gap-4 px-5 py-6 sm:px-6">
      <section>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">
          Shortcuts
        </h2>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map(({ href, label, description, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-white/[0.06] hover:bg-white/[0.03]"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-[#8A8A8A] transition group-hover:text-white">
                <Icon size={14} strokeWidth={2} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[#E0E0E0] group-hover:text-white">
                  {label}
                </span>
                <span className="block truncate text-[11px] text-[#6B6B6B]">
                  {description}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6B6B6B]">
          <Sparkles size={12} strokeWidth={2} className="text-[#00B4D8]" />
          Powered by PopAlpha
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[#8A8A8A]">
          Real-time market signals across every Pokémon TCG card — cross-referenced with live listings, condition pricing, and community sentiment.
        </p>
        <Link
          href="/about"
          className="mt-3 inline-flex text-[12px] font-medium text-[#00B4D8] hover:text-white"
        >
          Learn more →
        </Link>
      </section>
    </div>
  );
}
