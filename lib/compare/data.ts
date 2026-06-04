import type { ComparisonEntry } from "./types";

// Content for the /compare pages lives here so SEO copy is reviewable in one place.
// Claims about PopAlpha are grounded in actual features; competitor cells/notes
// stay general and defensible ("known for…", "varies", "not its core focus") and
// never invent specific competitor checkmarks, prices, or ratings.
// Emojis prefix the visible feature labels / section headings for quick scanning;
// the structured-data fields (h1, metaTitle, faq) stay emoji-free.

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
  tableCaption: "📊 How they compare",
  rows: [
    {
      feature: "📷 Free card scanning",
      popalpha: "Yes — unlimited, never paywalled",
      competitor: "Offered; scan limits vary by plan",
    },
    {
      feature: "🎯 Primary focus",
      popalpha: "Pokémon card scanner (raw + graded singles)",
      competitor: "Multi-game / multi-collectible tracking",
    },
    {
      feature: "💵 English card pricing",
      popalpha: "PopAlpha market feeds (real US sold data)",
      competitor: "Aggregated market pricing",
    },
    {
      feature: "🇯🇵 Japanese card pricing",
      popalpha: "Market-native (Yahoo! Auctions Japan + Snkrdunk)",
      competitor: "Not its core focus",
    },
    {
      feature: "🤖 AI market summaries",
      popalpha: "Daily brief + per-card summaries (3 free, then Pro)",
      competitor: "Not a stated feature",
    },
    {
      feature: "📈 Market signals",
      popalpha: "Top movers, drops, momentum, unusual volume, breakouts",
      competitor: "Portfolio value tracking",
    },
    {
      feature: "💼 Portfolio tracking",
      popalpha: "Holdings, cost basis, value over time",
      competitor: "Yes — a core strength",
    },
    {
      feature: "🏆 Grading / PSA support",
      popalpha: "PSA ladder, RAW vs PSA 9/10 premiums",
      competitor: "Grading fields vary",
    },
    {
      feature: "📱 Platform",
      popalpha: "iPhone app (early access) + live web market",
      competitor: "Mobile apps",
    },
    {
      feature: "🙋 Best for",
      popalpha: "Pokémon collectors who want fast scanning + market intelligence",
      competitor: "Collectors tracking many games in one place",
    },
  ],
  breakdown: [
    {
      heading: "💪 Where PopAlpha is stronger",
      paragraphs: [
        "PopAlpha is built specifically for the Pokémon market, so it goes deeper on the things Pokémon collectors actually trade on: variant-level pricing, RAW versus graded premiums, and a daily read on which cards and sets are moving.",
        "Japanese cards are a standout. PopAlpha prices them natively from Yahoo! Auctions Japan and Snkrdunk and uses whichever source has more recent sample sales, instead of converting a single English price into yen. For collectors of Japanese Pokémon cards, that market-native pricing is hard to find elsewhere.",
        "Scanning stays free and unlimited. You can identify cards as fast as you can point your camera, and the optional Pro tier layers market intelligence on top rather than gating the scanner.",
      ],
    },
    {
      heading: "⚖️ Where Collectr may fit better",
      paragraphs: [
        "Collectr is known for tracking many games and collectibles in one place. If your collection spans multiple trading card games — or other collectibles entirely — and you want a single combined portfolio view, that breadth is a genuine strength that a Pokémon-focused app does not try to match.",
      ],
    },
    {
      heading: "💸 Pricing and access",
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
    heading: "📲 Ready to try the free Pokémon card scanner?",
    body: "Unlimited free scanning plus English and Japanese card prices and AI market summaries. Join the waitlist and we'll email you when iPhone access opens.",
  },
  related: [
    "popalpha-vs-pricecharting",
    "best-free-tcg-scanner",
    "best-pokemon-card-price-app",
  ],
  updated: "2026-06-03",
};

const POPALPHA_VS_PRICECHARTING: ComparisonEntry = {
  kind: "versus",
  slug: "popalpha-vs-pricecharting",
  competitorName: "PriceCharting",
  competitorDescriptor: "a broad web price database for games, cards, and collectibles",
  h1: "PopAlpha vs PriceCharting",
  subtitle: "Scanner app vs price database — which is better for Pokémon cards?",
  metaTitle: "PopAlpha vs PriceCharting: Scanner App vs Price Database (2026)",
  metaDescription:
    "PopAlpha vs PriceCharting for Pokémon cards: a mobile scanner with English and Japanese pricing, AI summaries, and market signals versus a broad web price database. See which fits.",
  quickAnswer:
    "PopAlpha is a mobile Pokémon card scanner with market intelligence — point your camera to identify a card, then see English and Japanese prices, AI summaries, and market signals. PriceCharting is a broad web price database covering many categories, useful for quick reference lookups. If you want to scan cards and get Pokémon-specific intelligence on your phone, PopAlpha fits better; for wide web price lookups across collectibles, PriceCharting is handy. (PopAlpha actually uses PriceCharting as one of several English pricing sources.)",
  tableCaption: "📊 How they compare",
  rows: [
    {
      feature: "📷 Free card scanning",
      popalpha: "Yes — unlimited, in-app camera",
      competitor: "Not its primary focus",
    },
    {
      feature: "🎯 Primary focus",
      popalpha: "Pokémon card scanner + intelligence",
      competitor: "Broad price database (many categories)",
    },
    {
      feature: "💵 English card pricing",
      popalpha: "PopAlpha market feeds (real US sold data)",
      competitor: "Yes — a core strength",
    },
    {
      feature: "🇯🇵 Japanese card pricing",
      popalpha: "Market-native (Yahoo! Auctions Japan + Snkrdunk)",
      competitor: "Not its core focus",
    },
    {
      feature: "🤖 AI market summaries",
      popalpha: "Daily brief + per-card summaries",
      competitor: "Not a stated feature",
    },
    {
      feature: "📈 Market signals",
      popalpha: "Movers, momentum, breakouts",
      competitor: "Historical price data",
    },
    {
      feature: "💼 Portfolio tracking",
      popalpha: "Holdings, cost basis, value over time",
      competitor: "Collection tools vary",
    },
    {
      feature: "📱 Platform",
      popalpha: "iPhone app (early access) + live web",
      competitor: "Primarily web",
    },
    {
      feature: "🙋 Best for",
      popalpha: "Scanning + Pokémon market intelligence on mobile",
      competitor: "Broad web price lookups",
    },
  ],
  breakdown: [
    {
      heading: "💪 Where PopAlpha is stronger",
      paragraphs: [
        "PopAlpha is a camera-first mobile app: point it at a card to identify it, then get Pokémon-specific pricing and market context in seconds. It is built around the card in your hand, not a search box.",
        "It also prices Japanese cards natively from Yahoo! Auctions Japan and Snkrdunk, and layers on AI summaries and daily market signals — the 'why' behind a price, not just the number.",
      ],
    },
    {
      heading: "⚖️ Where PriceCharting may fit better",
      paragraphs: [
        "PriceCharting is a long-standing web price database spanning many categories beyond Pokémon — video games, other trading card games, comics and more. For quick reference lookups across a wide range of collectibles, that breadth is its strength.",
      ],
    },
    {
      heading: "🔗 Use them together",
      paragraphs: [
        "It isn't strictly either/or. PriceCharting is great for broad reference lookups across many categories, while PopAlpha turns real US sold data into a conservative market price the moment you scan a Pokémon card — and adds Japanese pricing most databases don't cover. Many collectors use a database for research and PopAlpha for the card in hand.",
      ],
    },
  ],
  faq: [
    {
      question: "Is PopAlpha free?",
      answer:
        "Yes. Scanning is free and unlimited, and you can browse prices and a small portfolio for free. Pro adds deeper analytics, collector insights, and price alerts, with a 7-day free trial.",
    },
    {
      question: "What is the difference between PopAlpha and PriceCharting?",
      answer:
        "PopAlpha is a mobile Pokémon card scanner with pricing and market intelligence; PriceCharting is a broad web price database across many categories. PopAlpha is camera-first and Pokémon-focused; PriceCharting is lookup-first and wide-ranging.",
    },
    {
      question: "Does PopAlpha cover Japanese Pokémon card prices?",
      answer:
        "Yes — natively, from Yahoo! Auctions Japan and Snkrdunk, rather than converting an English price into yen.",
    },
    {
      question: "Should I use PopAlpha or PriceCharting?",
      answer:
        "Use PopAlpha to scan cards and get Pokémon-specific pricing and signals on your phone. Use PriceCharting for broad web price lookups across many collectibles. They can complement each other — many collectors use a database for research and PopAlpha for the card in hand.",
    },
  ],
  cta: {
    heading: "📲 Scan a card, see its market price",
    body: "Free unlimited scanning with English and Japanese prices, AI summaries, and market signals. Join the waitlist and we'll email you when iPhone access opens.",
  },
  related: [
    "popalpha-vs-collectr",
    "best-free-tcg-scanner",
    "best-pokemon-card-price-app",
  ],
  updated: "2026-06-03",
};

const BEST_FREE_TCG_SCANNER: ComparisonEntry = {
  kind: "listicle",
  slug: "best-free-tcg-scanner",
  h1: "Best Free TCG Scanner Apps for Pokémon Cards",
  subtitle: "The top apps for scanning Pokémon cards free in 2026.",
  metaTitle: "Best Free TCG Scanner Apps for Pokémon Cards (2026)",
  metaDescription:
    "The best free TCG scanner apps for Pokémon cards in 2026, ranked. Unlimited free scanning, English and Japanese prices, and market intelligence compared.",
  quickAnswer:
    "If you want to scan Pokémon cards for free, PopAlpha is the strongest pick: unlimited free scanning that is never paywalled, plus English and Japanese prices, AI market summaries, and daily market signals. Other apps are better if you collect across many trading card games or want a broad collectibles portfolio. Here is how the best free TCG scanners compare for Pokémon.",
  intro:
    "A free TCG scanner should identify a card from your camera, keep scanning genuinely free, and give you something useful afterwards — ideally a real price, not just a name. These are the apps worth knowing for Pokémon, ranked for that job.",
  apps: [
    {
      rank: 1,
      name: "PopAlpha",
      isPopAlpha: true,
      oneLiner: "The free Pokémon card scanner with market intelligence built in.",
      bestFor: "Best for: Pokémon collectors who want unlimited free scanning plus pricing and signals.",
      notes: [
        "Unlimited free scanning — identifying cards is never paywalled",
        "English pricing from PopAlpha market feeds, plus market-native Japanese prices (Yahoo! Auctions Japan, Snkrdunk)",
        "Daily AI market brief and per-card summaries (3 free, then Pro)",
        "iPhone app in early access, with a live web market today",
      ],
    },
    {
      rank: 2,
      name: "Collectr",
      oneLiner: "A multi-game collection tracker with scanning.",
      bestFor: "Best for: collectors tracking many games and collectibles in one portfolio.",
      notes: [
        "Known for broad multi-collectible portfolio tracking",
        "Scanning is offered; free limits vary by plan",
        "Less Pokémon-specific market depth than a focused app",
      ],
    },
    {
      rank: 3,
      name: "Ludex",
      oneLiner: "A multi-TCG card scanner covering several games.",
      bestFor: "Best for: players who scan across multiple trading card games.",
      notes: [
        "Known for scanning across several TCGs",
        "Useful if your collection spans many games",
        "Pokémon market intelligence is not its main focus",
      ],
    },
    {
      rank: 4,
      name: "Marketplace & database apps (TCGplayer, PriceCharting)",
      oneLiner: "Great for buying cards or looking up reference prices.",
      bestFor: "Best for: price lookups and buying, rather than fast free scanning.",
      notes: [
        "Strong for reference prices and marketplaces",
        "Built around databases/marketplaces, not camera-first scanning",
        "PopAlpha gives you a market price right after a scan, instead of a manual lookup",
      ],
    },
  ],
  breakdown: [
    {
      heading: "🔎 What makes a free scanner actually useful",
      paragraphs: [
        "A good free scanner does three things well: it identifies cards quickly from your camera, it keeps scanning genuinely free, and it gives you something useful after the scan — a real price, not just a name.",
        "The catch with many 'free' scanners is that identifying a card is free, but prices, history, or portfolio features sit behind a paywall. PopAlpha keeps scanning unlimited and free, and adds pricing and market context on top.",
      ],
    },
    {
      heading: "💪 Why PopAlpha leads for Pokémon",
      paragraphs: [
        "PopAlpha is Pokémon-first, so the intelligence after the scan goes deeper: English and market-native Japanese pricing, a daily read on what is moving, and variant-aware values for raw and graded cards.",
      ],
    },
    {
      heading: "🧭 If you collect beyond Pokémon",
      paragraphs: [
        "If your collection spans many trading card games or other collectibles, a broad multi-game tool like Collectr or a multi-TCG scanner like Ludex may suit you better. PopAlpha trades that breadth for Pokémon depth.",
      ],
    },
    {
      heading: "📝 A note on free tiers",
      paragraphs: [
        "Free tiers and features change often, so check each app's current terms before you commit. The comparisons here describe each app's general focus rather than a fixed feature list.",
      ],
    },
  ],
  faq: [
    {
      question: "What is the best free Pokémon card scanner?",
      answer:
        "For Pokémon specifically, PopAlpha — it keeps scanning unlimited and free and adds English and Japanese pricing plus daily market signals on top.",
    },
    {
      question: "Is PopAlpha really free to scan?",
      answer:
        "Yes. Identifying cards with the camera is unlimited and never paywalled. A Pro subscription adds deeper analytics, collector insights, and alerts, but it never gates scanning.",
    },
    {
      question: "Do free card scanners limit how many cards you can scan?",
      answer:
        "Some do, or they paywall the prices after identifying the card. PopAlpha's scanning is unlimited and free, and you can browse prices and a small portfolio for free too.",
    },
    {
      question: "Does PopAlpha scan Japanese cards?",
      answer:
        "Yes, and it prices them natively from Yahoo! Auctions Japan and Snkrdunk rather than converting an English price — useful for collectors of Japanese Pokémon cards.",
    },
  ],
  cta: {
    heading: "📲 Try the free Pokémon card scanner",
    body: "Unlimited free scanning plus English and Japanese card prices and AI market summaries. Join the waitlist and we'll email you when iPhone access opens.",
  },
  related: [
    "popalpha-vs-collectr",
    "popalpha-vs-pricecharting",
    "best-pokemon-card-price-app",
  ],
  updated: "2026-06-03",
};

const BEST_POKEMON_CARD_PRICE_APP: ComparisonEntry = {
  kind: "listicle",
  slug: "best-pokemon-card-price-app",
  h1: "Best Pokémon Card Price Apps for Collectors",
  subtitle: "Where to check Pokémon card prices — and get the story behind them.",
  metaTitle: "Best Pokémon Card Price Apps for Collectors (2026)",
  metaDescription:
    "The best Pokémon card price apps in 2026, ranked. Compare English and Japanese pricing, market signals, scanning, and portfolio tracking.",
  quickAnswer:
    "PopAlpha is the best Pokémon card price app for collectors who want more than a number: free scanning to identify a card, English and Japanese market-native prices, AI summaries, and daily market signals. Price databases like PriceCharting are great for broad lookups, and portfolio apps like Collectr are strong for tracking a collection's value. Here are the best Pokémon card price apps, and who each is for.",
  intro:
    "The best price apps are honest about where a number comes from and how fresh it is. These are the options worth knowing for Pokémon, ranked for accuracy, Japanese coverage, and the context behind a price.",
  apps: [
    {
      rank: 1,
      name: "PopAlpha",
      isPopAlpha: true,
      oneLiner: "Prices plus the market story behind them.",
      bestFor: "Best for: collectors who want accurate prices and the context around them.",
      notes: [
        "English and market-native Japanese prices in one place",
        "A conservative market price with clear freshness / staleness labels",
        "Daily movers, momentum, and breakout signals",
        "Free scanning and a free portfolio; Pro adds deeper analytics",
      ],
    },
    {
      rank: 2,
      name: "PriceCharting",
      oneLiner: "A broad web price database for quick lookups.",
      bestFor: "Best for: fast reference prices across many collectible categories.",
      notes: [
        "Long-standing price guide across games, cards, and more",
        "Great for quick historical lookups",
        "US/English-oriented; less focused on Japanese market value",
      ],
    },
    {
      rank: 3,
      name: "Collectr",
      oneLiner: "Portfolio-first price tracking across games.",
      bestFor: "Best for: tracking a multi-game collection's value over time.",
      notes: [
        "Strong portfolio and collection-value tracking",
        "Covers many games and collectibles",
        "Less Pokémon-specific market depth",
      ],
    },
    {
      rank: 4,
      name: "eBay sold listings",
      oneLiner: "The raw sold comps many collectors check by hand.",
      bestFor: "Best for: verifying a specific recent sale yourself.",
      notes: [
        "The closest thing to ground-truth recent sales",
        "Requires manual averaging and condition judgement",
        "PopAlpha turns real US sold data into a market price for you, so you don't have to average comps by hand",
      ],
    },
  ],
  breakdown: [
    {
      heading: "💵 What makes a price app trustworthy",
      paragraphs: [
        "The best Pokémon card price apps are honest about where a price comes from and how fresh it is. A single 'value' with no date can mislead — markets move, and a stale comp is worse than none.",
        "PopAlpha anchors on a conservative market price from recent sold data and labels how fresh it is, so you know whether you are looking at a live price or an old one.",
      ],
    },
    {
      heading: "🇯🇵 Japanese prices need Japanese sources",
      paragraphs: [
        "Japanese cards trade on Japanese marketplaces, so converting an English price into yen misses the real market. PopAlpha prices Japanese cards natively from Yahoo! Auctions Japan and Snkrdunk — more on that on our Japanese card prices page.",
      ],
    },
    {
      heading: "💪 Why PopAlpha",
      paragraphs: [
        "PopAlpha combines English and Japanese pricing, freshness labels, and market signals with free scanning, so you can go from a card in hand to its price and its trend in seconds.",
      ],
    },
    {
      heading: "📝 A note on sources",
      paragraphs: [
        "English prices come from PopAlpha's own market feeds; Japanese prices come natively from Yahoo! Auctions Japan and Snkrdunk. Prices can change, so always sanity-check a high-value purchase against recent sales.",
      ],
    },
  ],
  faq: [
    {
      question: "What is the best app for Pokémon card prices?",
      answer:
        "PopAlpha is built for it: English and market-native Japanese prices, a conservative market price with freshness labels, and market signals — plus free scanning to identify the card first.",
    },
    {
      question: "What is the best app for Japanese Pokémon card prices?",
      answer:
        "PopAlpha. It prices Japanese cards natively from Yahoo! Auctions Japan and Snkrdunk, choosing the source with more recent sample sales instead of converting an English price.",
    },
    {
      question: "Is PopAlpha free for checking prices?",
      answer:
        "Yes. You can browse prices and track a small portfolio for free. Pro unlocks deeper analytics, collector insights, and price alerts, with a 7-day free trial.",
    },
    {
      question: "How does PopAlpha decide a card's price?",
      answer:
        "It anchors on a conservative market price from recent sold data and labels how fresh that price is, so you can tell a live price from a stale one.",
    },
  ],
  cta: {
    heading: "📲 Get Pokémon prices the moment you scan",
    body: "Free scanning with English and Japanese market prices, freshness labels, and daily signals. Join the waitlist and we'll email you when iPhone access opens.",
  },
  related: [
    "popalpha-vs-collectr",
    "popalpha-vs-pricecharting",
    "best-free-tcg-scanner",
  ],
  updated: "2026-06-03",
};

export const COMPARISONS: ComparisonEntry[] = [
  POPALPHA_VS_COLLECTR,
  POPALPHA_VS_PRICECHARTING,
  BEST_FREE_TCG_SCANNER,
  BEST_POKEMON_CARD_PRICE_APP,
];

export function getAllComparisonSlugs(): string[] {
  return COMPARISONS.map((entry) => entry.slug);
}

export function getComparison(slug: string): ComparisonEntry | undefined {
  return COMPARISONS.find((entry) => entry.slug === slug);
}
