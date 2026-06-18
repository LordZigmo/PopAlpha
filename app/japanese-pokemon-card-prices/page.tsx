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
  "Japanese Pokémon cards trade on Japanese marketplaces, so their real value is whatever they actually sell for there — which can differ from the US price, especially with the yen exchange rate in play. PopAlpha prices Japanese cards natively from Yahoo! Auctions Japan and Snkrdunk, using whichever source has more recent sample sales. Here's how Japanese card pricing works, and how to use it to your advantage.";

const ROWS: VersusRow[] = [
  {
    feature: "📊 Price basis",
    popalpha: "Japanese sold listings (Yahoo! JP, Snkrdunk)",
    competitor: "What the card sells for in the US",
  },
  {
    feature: "🇯🇵 Reflects Japanese demand",
    popalpha: "Yes",
    competitor: "No — it tracks the US market",
  },
  {
    feature: "🕒 Freshness",
    popalpha: "Recent Japanese sample sales, with staleness labels",
    competitor: "Whatever the US listing shows",
  },
  {
    feature: "🎯 Accuracy for a Japanese card",
    popalpha: "Market-native",
    competitor: "Often off — Japan and the US move apart, and the yen widens the gap",
  },
];

const SECTIONS: BreakdownSection[] = [
  {
    heading: "🇯🇵 Why Japanese cards need Japanese prices",
    paragraphs: [
      "Japanese Pokémon cards are bought and sold mostly on Japanese marketplaces, so their real value is whatever they actually sell for there. And that's where the opportunity is: because Japanese prices and the yen exchange rate often differ from the rest of the world, knowing the true Japanese market price is how collectors save money buying from Japan — or profit on the difference when the same card sells for more abroad.",
      "English and Japanese markets move independently — a card can be common in one and sought-after in the other — so the price you see abroad can be a poor guide to what a Japanese copy is really worth.",
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
    heading: "🌍 English Cards vs Japanese Cards: Different Markets",
    paragraphs: [
      "PopAlpha uses English market data for English cards and Japanese market data for Japanese cards. Rather than converting one market into another, PopAlpha matches each card to the market where that version actually trades.",
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
    question: "Is it cheaper to buy Pokémon cards from Japan?",
    answer:
      "Often, yes — Japanese cards can sell for less on Japanese marketplaces, and a favorable yen exchange rate can widen that gap. The catch is knowing the real Japanese market price first, which PopAlpha shows natively from Yahoo! Auctions Japan and Snkrdunk so you can tell when buying from Japan actually saves money.",
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
        caption="📊 The Japanese price vs the US price"
        competitorName="Going by the US price"
        rows={ROWS}
      />
      <HonestBreakdown sections={SECTIONS} />
      <ComparisonFaq items={FAQ} />
      <ComparisonCta
        cta={{
          heading: "📲 Check Japanese card prices on PopAlpha",
          body: "Free scanning with market-native Japanese pricing from Yahoo! Auctions Japan and Snkrdunk. Download PopAlpha free on the App Store.",
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
