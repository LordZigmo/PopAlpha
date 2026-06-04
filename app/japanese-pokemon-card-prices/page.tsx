import type { Metadata } from "next";
import Link from "next/link";
import {
  breadcrumbSchema,
  faqPageSchema,
  softwareApplicationSchema,
} from "@/lib/compare/schema";
import type { BreakdownSection, FaqItem, VersusRow } from "@/lib/compare/types";
import CompareShell from "@/components/compare/compare-shell";
import JsonLd from "@/components/compare/json-ld";
import ComparisonHero from "@/components/compare/comparison-hero";
import ComparisonTable from "@/components/compare/comparison-table";
import HonestBreakdown from "@/components/compare/honest-breakdown";
import ComparisonFaq from "@/components/compare/comparison-faq";
import ComparisonCta from "@/components/compare/comparison-cta";
import CompareCrossLinks from "@/components/compare/compare-cross-links";

const title = "Japanese Pokémon Card Prices: How to Check JP Market Value (2026)";
const description =
  "How to check Japanese Pokémon card prices using market-native sources. PopAlpha prices Japanese cards from Yahoo! Auctions Japan and Snkrdunk — real JP market value, not a converted English price.";
const canonicalPath = "/japanese-pokemon-card-prices";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: canonicalPath },
  openGraph: {
    title,
    description,
    url: canonicalPath,
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

const LEAD =
  "Japanese Pokémon cards trade on Japanese marketplaces, so their real value comes from Japanese sold data — not an English price converted into yen. PopAlpha prices Japanese cards natively from Yahoo! Auctions Japan and Snkrdunk, using whichever source has more recent sample sales. Here's how Japanese card pricing works and how to check it.";

const ROWS: VersusRow[] = [
  {
    feature: "📊 Price basis",
    popalpha: "Japanese sold listings (Yahoo! JP, Snkrdunk)",
    competitor: "English market, converted to yen",
  },
  {
    feature: "🇯🇵 Reflects Japanese demand",
    popalpha: "Yes",
    competitor: "No — mirrors the English market",
  },
  {
    feature: "🕒 Freshness",
    popalpha: "Recent JP sample sales, with staleness labels",
    competitor: "Tied to the English source",
  },
  {
    feature: "🎯 Accuracy for JP cards",
    popalpha: "Market-native",
    competitor: "Often off — JP and EN prices diverge",
  },
];

const SECTIONS: BreakdownSection[] = [
  {
    heading: "🇯🇵 Why Japanese cards need Japanese prices",
    paragraphs: [
      "Japanese Pokémon cards are bought and sold mostly on Japanese marketplaces. Their real value comes from what they actually sell for there — not from taking an English price and converting it into yen.",
      "English and Japanese markets diverge: a card can be common in one and sought-after in the other. Converting across them hides that gap.",
    ],
  },
  {
    heading: "🔍 How PopAlpha prices Japanese cards",
    paragraphs: [
      "PopAlpha reads Japanese sold data from Yahoo! Auctions Japan and Snkrdunk, and uses whichever source has more recent sample sales for a given card. The result is a market-native Japanese price, labelled with how fresh it is.",
      "When there isn't enough recent Japanese data, PopAlpha says so rather than guessing — an honest 'no recent market' beats a made-up number.",
    ],
  },
  {
    heading: "📈 EN vs JP: the same card, two markets",
    paragraphs: [
      "Because the two markets move independently, PopAlpha tracks both and can surface where Japanese and English prices diverge — useful if you buy or sell across regions.",
    ],
  },
];

const FAQ: FaqItem[] = [
  {
    question: "How do I check Japanese Pokémon card prices?",
    answer:
      "Look at Japanese sold data — marketplaces like Yahoo! Auctions Japan and Snkrdunk. PopAlpha aggregates these into a single market-native price so you don't have to translate listings and average them yourself.",
  },
  {
    question: "Does PopAlpha convert English prices into yen?",
    answer:
      "No. For Japanese cards it uses native Japanese sold data from Yahoo! Auctions Japan and Snkrdunk, not a converted English price.",
  },
  {
    question: "Are Japanese Pokémon cards worth more than English ones?",
    answer:
      "Sometimes — it depends on the card. The two markets move independently, which is exactly why a market-native Japanese price matters. PopAlpha shows both so you can compare.",
  },
  {
    question: "Yahoo! Auctions Japan or Snkrdunk — which price should I trust?",
    answer:
      "PopAlpha uses whichever has more recent sample sales for that specific card, so the price reflects the freshest real Japanese market activity.",
  },
];

export default function JapanesePricesPage() {
  const jsonLd = [
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "Japanese Pokémon Card Prices", path: canonicalPath },
    ]),
    faqPageSchema(FAQ),
    softwareApplicationSchema(),
  ];

  return (
    <CompareShell
      footnote={
        <>
          Updated June 3, 2026 ·{" "}
          <Link
            href="/compare"
            className="text-[#8A8A8E] underline-offset-2 hover:text-white hover:underline"
          >
            Compare apps
          </Link>
        </>
      }
    >
      <JsonLd data={jsonLd} />
      <ComparisonHero
        h1="Japanese Pokémon Card Prices"
        subtitle="How to check the real market value of Japanese Pokémon cards."
        lead={LEAD}
      />
      <ComparisonTable
        caption="📊 Market-native vs converted pricing"
        competitorName="Converted EN price"
        rows={ROWS}
      />
      <HonestBreakdown sections={SECTIONS} />
      <ComparisonFaq items={FAQ} />
      <ComparisonCta
        cta={{
          heading: "📲 Check Japanese card prices on PopAlpha",
          body: "Free scanning with market-native Japanese pricing from Yahoo! Auctions Japan and Snkrdunk. Join the waitlist and we'll email you when iPhone access opens.",
        }}
      />
      <CompareCrossLinks
        related={[
          "popalpha-vs-collectr",
          "popalpha-vs-pricecharting",
          "best-free-tcg-scanner",
          "best-pokemon-card-price-app",
        ]}
        showJapanese={false}
      />
    </CompareShell>
  );
}
