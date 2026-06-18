import type { Metadata } from "next";
import Link from "next/link";
import { COMPARISONS } from "@/lib/compare/data";
import { breadcrumbSchema, itemListSchema } from "@/lib/compare/schema";
import CompareShell from "@/components/compare/compare-shell";
import JsonLd from "@/components/compare/json-ld";
import ComparisonCta from "@/components/compare/comparison-cta";

const title = "Compare Pokémon Card Apps & Prices | PopAlpha";
const description =
  "Compare the best Pokémon card scanner and price apps — PopAlpha vs Collectr, vs PriceCharting, the best free TCG scanners, and the best Pokémon card price apps.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/compare" },
  openGraph: {
    title,
    description,
    url: "/compare",
    siteName: "PopAlpha",
    type: "website",
    images: [{ url: "/opengraph-image", alt: "PopAlpha" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/twitter-image"],
  },
};

const EXTRA_LINKS = [
  {
    href: "/japanese-pokemon-card-prices",
    label: "Japanese Pokémon Card Prices",
    sub: "How to check JP market value with market-native sources",
  },
];

export default function CompareIndexPage() {
  const links = [
    ...COMPARISONS.map((entry) => ({
      href: `/compare/${entry.slug}`,
      label: entry.h1,
      sub: entry.subtitle,
    })),
    ...EXTRA_LINKS,
  ];

  const jsonLd = [
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "Compare", path: "/compare" },
    ]),
    itemListSchema(links.map((link) => link.label)),
  ];

  return (
    <CompareShell
      footnote={
        <Link
          href="/"
          className="text-[#8A8A8E] underline-offset-2 hover:text-white hover:underline"
        >
          popalpha.ai
        </Link>
      }
    >
      <JsonLd data={jsonLd} />
      <h1 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-white sm:text-[48px]">
        Compare Pokémon card apps
      </h1>
      <p className="mt-3 text-[18px] leading-7 text-[#8A8A8E] sm:text-[20px]">
        Honest head-to-heads and best-of guides for scanning, pricing, and understanding Pokémon cards.
      </p>

      <ul className="mt-10 divide-y divide-white/[0.08]">
        {links.map((link) => (
          <li key={link.href} className="py-5 first:pt-0">
            <Link href={link.href} className="group flex items-baseline justify-between gap-4">
              <span>
                <span className="text-[20px] font-semibold text-[#E8E8E8] transition-colors group-hover:text-white sm:text-[22px]">
                  {link.label}
                </span>
                <span className="mt-1 block text-[16px] text-[#8A8A8E]">{link.sub}</span>
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

      <ComparisonCta
        cta={{
          heading: "📲 Try the free Pokémon card scanner",
          body: "Unlimited free scanning plus English and Japanese card prices and AI market summaries. Download PopAlpha free on the App Store.",
        }}
      />
    </CompareShell>
  );
}
