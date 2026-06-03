import type { ComparisonEntry } from "./types";

// Content for the /compare pages lives here so SEO copy is reviewable in one place.
// Claims about PopAlpha are grounded in actual features; competitor cells stay
// general and defensible ("known for…", "varies", "not its core focus") and never
// invent specific competitor checkmarks, prices, or ratings.

const POPALPHA_VS_COLLECTR: ComparisonEntry = {
  kind: "versus",
  slug: "popalpha-vs-collectr",
  competitorName: "Collectr",
  competitorDescriptor: "a multi-game, multi-collectible portfolio tracker",
  h1: "PopAlpha vs Collectr",
  subtitle:
    "Which app is better for scanning, pricing, and understanding Pokémon cards?",
  metaTitle:
    "PopAlpha vs Collectr: Which Pokémon Card App Is Better for Scanning? (2026)",
  metaDescription:
    "PopAlpha vs Collectr compared for Pokémon collectors: free unlimited card scanning, English and Japanese card prices, AI market summaries, and market signals. See which app fits your collection.",
  quickAnswer:
    "PopAlpha is best for collectors who want unlimited free Pokémon card scanning plus market intelligence — English and Japanese card prices, AI market summaries, and daily market signals. Collectr is known for tracking many games and collectibles in one portfolio, so it may fit better if you collect across several TCGs. If you focus on Pokémon — especially Japanese cards and market trends — PopAlpha goes deeper.",
  tableCaption: "How they compare",
  rows: [
    {
      feature: "Free card scanning",
      popalpha: "Yes — unlimited, never paywalled",
      competitor: "Offered; scan limits vary by plan",
    },
    {
      feature: "Primary focus",
      popalpha: "Pokémon card scanner (raw + graded singles)",
      competitor: "Multi-game / multi-collectible tracking",
    },
    {
      feature: "English card pricing",
      popalpha: "Scrydex, PriceCharting, eBay sold listings",
      competitor: "Aggregated market pricing",
    },
    {
      feature: "Japanese card pricing",
      popalpha: "Market-native (Yahoo! Auctions Japan + Snkrdunk)",
      competitor: "Not its core focus",
    },
    {
      feature: "AI market summaries",
      popalpha: "Daily brief + per-card summaries (3 free, then Pro)",
      competitor: "Not a stated feature",
    },
    {
      feature: "Market signals",
      popalpha: "Top movers, drops, momentum, unusual volume, breakouts",
      competitor: "Portfolio value tracking",
    },
    {
      feature: "Portfolio tracking",
      popalpha: "Holdings, cost basis, value over time",
      competitor: "Yes — a core strength",
    },
    {
      feature: "Grading / PSA support",
      popalpha: "PSA ladder, RAW vs PSA 9/10 premiums",
      competitor: "Grading fields vary",
    },
    {
      feature: "Platform",
      popalpha: "iPhone app (early access) + live web market",
      competitor: "Mobile apps",
    },
    {
      feature: "Best for",
      popalpha: "Pokémon collectors who want fast scanning + market intelligence",
      competitor: "Collectors tracking many games in one place",
    },
  ],
  breakdown: [
    {
      heading: "Where PopAlpha is stronger",
      paragraphs: [
        "PopAlpha is built specifically for the Pokémon market, so it goes deeper on the things Pokémon collectors actually trade on: variant-level pricing, RAW versus graded premiums, and a daily read on which cards and sets are moving.",
        "Japanese cards are a standout. PopAlpha prices them natively from Yahoo! Auctions Japan and Snkrdunk and uses whichever source has more recent sample sales, instead of converting a single English price into yen. For collectors of Japanese Pokémon cards, that market-native pricing is hard to find elsewhere.",
        "Scanning stays free and unlimited. You can identify cards as fast as you can point your camera, and the optional Pro tier layers market intelligence on top rather than gating the scanner.",
      ],
    },
    {
      heading: "Where Collectr may fit better",
      paragraphs: [
        "Collectr is known for tracking many games and collectibles in one place. If your collection spans multiple trading card games — or other collectibles entirely — and you want a single combined portfolio view, that breadth is a genuine strength that a Pokémon-focused app does not try to match.",
      ],
    },
    {
      heading: "Pricing and access",
      paragraphs: [
        "PopAlpha's card scanning, price lookups, and a small portfolio are free. A Pro subscription — monthly or yearly, with a 7-day free trial — unlocks deeper market analytics, collector insights, and price alerts.",
        "The PopAlpha scanner app is currently in early access on iPhone via the waitlist, while the live web market (prices, signals, and set summaries) is available now in any browser.",
      ],
    },
  ],
  faq: [
    {
      question: "Is PopAlpha free?",
      answer:
        "Yes. Card scanning is free and unlimited, and you can browse prices and track a small portfolio for free. A Pro subscription unlocks deeper market analytics, collector insights, and price alerts, and comes with a 7-day free trial.",
    },
    {
      question: "Does PopAlpha track Japanese Pokémon card prices?",
      answer:
        "Yes. PopAlpha prices Japanese cards natively using Yahoo! Auctions Japan and Snkrdunk, choosing the source with more recent sample sales rather than converting an English price. That makes it well suited to collectors of Japanese Pokémon cards.",
    },
    {
      question: "Is PopAlpha available on Android?",
      answer:
        "Not yet. The scanner app is iPhone-only today and currently in early access via the waitlist. The PopAlpha web market — prices, signals, and set summaries — works in any browser in the meantime.",
    },
    {
      question: "Should I use PopAlpha or Collectr?",
      answer:
        "Use PopAlpha if you focus on Pokémon and want fast scanning, English and Japanese pricing, AI market summaries, and market signals. Consider Collectr if you collect across many games or collectibles and want one combined portfolio.",
    },
  ],
  cta: {
    heading: "Ready to try the free Pokémon card scanner?",
    body: "Unlimited free scanning plus English and Japanese card prices and AI market summaries. Join the waitlist and we'll email you when iPhone access opens.",
  },
  related: [],
  updated: "2026-06-03",
};

export const COMPARISONS: ComparisonEntry[] = [POPALPHA_VS_COLLECTR];

export function getAllComparisonSlugs(): string[] {
  return COMPARISONS.map((entry) => entry.slug);
}

export function getComparison(slug: string): ComparisonEntry | undefined {
  return COMPARISONS.find((entry) => entry.slug === slug);
}
