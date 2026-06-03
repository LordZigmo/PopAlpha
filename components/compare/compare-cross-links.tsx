import Link from "next/link";
import { getComparison } from "@/lib/compare/data";

type CompareCrossLinksProps = {
  currentSlug?: string;
  related: string[];
  /** Append the standalone Japanese-prices page (off on that page itself). */
  showJapanese?: boolean;
};

// Internal-linking block: links sibling comparison pages (+ the JP resource) so
// the set interlinks for crawlers and readers.
export default function CompareCrossLinks({
  currentSlug,
  related,
  showJapanese = true,
}: CompareCrossLinksProps) {
  const items = related
    .filter((slug) => slug !== currentSlug)
    .map((slug) => getComparison(slug))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => ({ href: `/compare/${entry.slug}`, label: entry.h1, sub: entry.subtitle }));

  if (showJapanese) {
    items.push({
      href: "/japanese-pokemon-card-prices",
      label: "Japanese Pokémon Card Prices",
      sub: "How to check JP market value",
    });
  }

  if (items.length === 0) return null;

  return (
    <section className="mt-16">
      <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-white sm:text-[22px]">
        Keep comparing
      </h2>
      <ul className="mt-5 divide-y divide-white/[0.06]">
        {items.map((item) => (
          <li key={item.href} className="py-3.5 first:pt-0">
            <Link
              href={item.href}
              className="group flex items-baseline justify-between gap-4"
            >
              <span>
                <span className="text-[17px] font-medium text-[#E8E8E8] transition-colors group-hover:text-white">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[15px] text-[#8A8A8E]">{item.sub}</span>
              </span>
              <span
                aria-hidden="true"
                className="text-[#6B6B6B] transition-colors group-hover:text-[#00B4D8]"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
