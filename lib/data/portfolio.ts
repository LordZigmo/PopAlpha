import "server-only";
import { normalizeHoldingGrade } from "@/lib/holdings/grade-normalize";

/**
 * Portfolio analysis library.
 *
 * Computes collector identity, composition, attributes, top holdings,
 * and heuristic insights from raw holdings + market data.
 *
 * Pricing convention (Phase 2, 2026-05): the `priceMap` parameter is keyed
 * by `${canonical_slug}::${bucket}` where bucket is the graded bucket from
 * `lib/holdings/grade-normalize` (RAW, LE_7, G8, G9, G9_5, G10, G10_PERFECT).
 * Each lookup tries the holding's own bucket first and falls back to RAW so
 * a graded holding without a per-bucket card_metrics row still contributes
 * its slug's RAW price rather than dropping to zero.
 */

function lookupHoldingPrice(
  priceMap: Map<string, number>,
  slug: string,
  grade: string,
): number | undefined {
  const bucket = normalizeHoldingGrade(grade);
  return priceMap.get(`${slug}::${bucket}`) ?? priceMap.get(`${slug}::RAW`);
}

// ── Era Classification ──────────────────────────────────────────────────────

export type Era = "WotC (Base–Neo)" | "EX Series" | "Diamond & Pearl" | "BW / XY" | "Modern";

export function classifyEra(year: number | null): Era {
  if (year == null) return "Modern";
  if (year <= 2002) return "WotC (Base–Neo)";
  if (year <= 2006) return "EX Series";
  if (year <= 2010) return "Diamond & Pearl";
  if (year <= 2016) return "BW / XY";
  return "Modern";
}

// ── Grade Parsing ───────────────────────────────────────────────────────────

export function isGraded(grade: string): boolean {
  const g = grade.toUpperCase();
  return g !== "RAW" && (g.includes("PSA") || g.includes("CGC") || g.includes("BGS"));
}

export function parseGradeNumeric(grade: string): number | null {
  const match = grade.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// ── Portfolio Attributes ────────────────────────────────────────────────────

export type PortfolioAttributes = {
  vintagePercent: number;
  gradedPercent: number;
  sealedPercent: number;
  topHoldingConcentration: number;
  setBreadth: number;
  nostalgiaScore: number;
  modernPercent: number;
  grailDensity: number;
  trophyDensity: number;
  avgGrade: number;
  setCompletionRate: number;
};

type HoldingInput = {
  canonical_slug: string;
  qty: number;
  grade: string;
  price_paid_usd: number;
};

type CardMeta = {
  set_name: string | null;
  year: number | null;
};

export function computeAttributes(
  holdings: HoldingInput[],
  cardMap: Map<string, CardMeta>,
  priceMap: Map<string, number>,
): PortfolioAttributes {
  if (holdings.length === 0) {
    return {
      vintagePercent: 0, gradedPercent: 0, sealedPercent: 0,
      topHoldingConcentration: 0, setBreadth: 0, nostalgiaScore: 0,
      modernPercent: 0, grailDensity: 0, trophyDensity: 0,
      avgGrade: 0, setCompletionRate: 0,
    };
  }

  let totalQty = 0;
  let vintageQty = 0;
  let gradedQty = 0;
  let modernQty = 0;
  let gradeSum = 0;
  let gradeCount = 0;
  const sets = new Set<string>();
  const holdingValues: number[] = [];
  let totalValue = 0;
  let grailCount = 0;
  let trophyCount = 0;

  for (const h of holdings) {
    const qty = h.qty || 1;
    totalQty += qty;

    const meta = cardMap.get(h.canonical_slug);
    const era = classifyEra(meta?.year ?? null);
    if (era === "WotC (Base–Neo)" || era === "EX Series") vintageQty += qty;
    if (era === "Modern") modernQty += qty;
    if (meta?.set_name) sets.add(meta.set_name);

    if (isGraded(h.grade)) {
      gradedQty += qty;
      const num = parseGradeNumeric(h.grade);
      if (num != null) { gradeSum += num * qty; gradeCount += qty; }
    }

    const marketPrice = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade) ?? h.price_paid_usd;
    const positionValue = marketPrice * qty;
    holdingValues.push(positionValue);
    totalValue += positionValue;

    if (marketPrice >= 500) grailCount += qty;
    if (marketPrice >= 1000) trophyCount += qty;
  }

  // Top-3 concentration
  const sorted = [...holdingValues].sort((a, b) => b - a);
  const top3Value = sorted.slice(0, 3).reduce((s, v) => s + v, 0);
  const topHoldingConcentration = totalValue > 0 ? top3Value / totalValue : 0;

  // Set breadth: 0 = 1 set, 1 = 15+ sets (normalized)
  const setBreadth = Math.min(sets.size / 15, 1);

  // Nostalgia: weighted by how old the cards are
  let nostalgiaScore = 0;
  for (const h of holdings) {
    const meta = cardMap.get(h.canonical_slug);
    const year = meta?.year ?? 2024;
    const age = Math.max(0, 2026 - year);
    nostalgiaScore += Math.min(age / 25, 1) * h.qty;
  }
  nostalgiaScore = totalQty > 0 ? nostalgiaScore / totalQty : 0;

  return {
    vintagePercent: totalQty > 0 ? vintageQty / totalQty : 0,
    gradedPercent: totalQty > 0 ? gradedQty / totalQty : 0,
    sealedPercent: 0,
    topHoldingConcentration,
    setBreadth,
    nostalgiaScore,
    modernPercent: totalQty > 0 ? modernQty / totalQty : 0,
    grailDensity: totalQty > 0 ? grailCount / totalQty : 0,
    trophyDensity: totalQty > 0 ? trophyCount / totalQty : 0,
    avgGrade: gradeCount > 0 ? gradeSum / gradeCount : 0,
    setCompletionRate: 0, // requires set-total lookup, omit for now
  };
}

// ── Collector Identity Engine ───────────────────────────────────────────────

export const COLLECTOR_TYPES = [
  "grail_hunter", "set_finisher", "nostalgia_curator", "modern_momentum",
  "trophy_collector", "market_opportunist", "completionist", "graded_purist",
  "binder_builder", "sealed_strategist",
] as const;

export type CollectorType = (typeof COLLECTOR_TYPES)[number];

export type CollectorIdentity = {
  primary_type: CollectorType;
  confidence: number;
  explanation: string;
  traits: { type: CollectorType; strength: number }[];
};

function weighted(pairs: [number, number][]): number {
  return pairs.reduce((sum, [v, w]) => sum + v * w, 0);
}

function scoreType(type: CollectorType, a: PortfolioAttributes): number {
  switch (type) {
    case "grail_hunter":
      return weighted([[a.grailDensity, 0.35], [a.topHoldingConcentration, 0.25], [a.vintagePercent, 0.15], [1 - a.setBreadth, 0.15], [a.trophyDensity, 0.10]]);
    case "set_finisher":
      return weighted([[a.setCompletionRate, 0.40], [a.setBreadth, 0.30], [1 - a.topHoldingConcentration, 0.15], [1 - a.grailDensity, 0.15]]);
    case "nostalgia_curator":
      return weighted([[a.nostalgiaScore, 0.35], [a.vintagePercent, 0.30], [1 - a.modernPercent, 0.15], [a.grailDensity, 0.10], [a.topHoldingConcentration, 0.10]]);
    case "modern_momentum":
      return weighted([[a.modernPercent, 0.40], [1 - a.vintagePercent, 0.25], [1 - a.nostalgiaScore, 0.20], [a.setBreadth, 0.15]]);
    case "trophy_collector":
      return weighted([[a.trophyDensity, 0.35], [a.grailDensity, 0.25], [a.topHoldingConcentration, 0.20], [a.gradedPercent, 0.10], [Math.min(a.avgGrade / 10, 1), 0.10]]);
    case "market_opportunist":
      return weighted([[a.modernPercent, 0.25], [a.setBreadth, 0.25], [1 - a.nostalgiaScore, 0.20], [1 - a.topHoldingConcentration, 0.15], [1 - a.vintagePercent, 0.15]]);
    case "completionist":
      return weighted([[a.setBreadth, 0.35], [a.setCompletionRate, 0.30], [1 - a.topHoldingConcentration, 0.20], [1 - a.grailDensity, 0.15]]);
    case "graded_purist":
      return weighted([[a.gradedPercent, 0.40], [Math.min(a.avgGrade / 10, 1), 0.30], [a.grailDensity, 0.15], [a.topHoldingConcentration, 0.15]]);
    case "binder_builder":
      return weighted([[1 - a.gradedPercent, 0.30], [1 - a.sealedPercent, 0.20], [a.setBreadth, 0.25], [1 - a.topHoldingConcentration, 0.15], [1 - a.grailDensity, 0.10]]);
    case "sealed_strategist":
      return weighted([[a.sealedPercent, 0.50], [1 - a.gradedPercent, 0.20], [a.modernPercent, 0.15], [1 - a.vintagePercent, 0.15]]);
  }
}

const EXPLANATIONS: Record<CollectorType, string> = {
  grail_hunter: "You go after the big cards. Your portfolio is built around the ones every collector wants, not lots of small pieces.",
  set_finisher: "You build set by set. Your portfolio shows you are working through sets you care about, one card at a time.",
  nostalgia_curator: "You collect what means something to you. Your portfolio leans toward iconic, classic cards over pure speculation.",
  modern_momentum: "You stay close to what is new. Your portfolio is full of recent sets and chase cards that are getting attention right now.",
  trophy_collector: "Your collection is a highlight reel. You go for the cards that define a collection and stand out at a glance.",
  market_opportunist: "You collect with a trader's eye. Your portfolio shows you spot good buying ranges across different eras and styles.",
  completionist: "You collect wide. Your portfolio covers a lot of sets and eras, built around the joy of finding cards you don't have yet.",
  graded_purist: "Condition matters most to you. Your portfolio leans heavily on graded cards, especially the top grades.",
  binder_builder: "You collect for the feel of it. Your portfolio is mostly raw cards built to hold, flip through, and enjoy.",
  sealed_strategist: "You play the long game. Your portfolio leans into sealed product, betting that today's boxes are tomorrow's grails.",
};

export function computeIdentity(attrs: PortfolioAttributes): CollectorIdentity {
  const scores = COLLECTOR_TYPES.map((t) => ({ type: t, score: scoreType(t, attrs) }))
    .sort((a, b) => b.score - a.score);

  const primary = scores[0]!;
  const traits = scores.slice(1, 4).map((s) => ({ type: s.type, strength: Math.round(s.score * 100) / 100 }));

  return {
    primary_type: primary.type,
    confidence: Math.round(primary.score * 100) / 100,
    explanation: EXPLANATIONS[primary.type],
    traits,
  };
}

// ── Composition ─────────────────────────────────────────────────────────────

export type CompositionSegment = { label: string; value: number };

export function computeComposition(
  holdings: HoldingInput[],
  cardMap: Map<string, CardMeta>,
  priceMap: Map<string, number>,
): { by_era: CompositionSegment[]; by_category: CompositionSegment[] } {
  const eraValues: Record<string, number> = {};
  let rawValue = 0;
  let gradedValue = 0;
  let totalValue = 0;

  for (const h of holdings) {
    const meta = cardMap.get(h.canonical_slug);
    const era = classifyEra(meta?.year ?? null);
    const price = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade) ?? h.price_paid_usd;
    const val = price * (h.qty || 1);

    eraValues[era] = (eraValues[era] || 0) + val;
    if (isGraded(h.grade)) gradedValue += val; else rawValue += val;
    totalValue += val;
  }

  const byEra = Object.entries(eraValues)
    .map(([label, v]) => ({ label, value: totalValue > 0 ? Math.round((v / totalValue) * 100) / 100 : 0 }))
    .sort((a, b) => b.value - a.value);

  const byCategory = [
    { label: "Raw", value: totalValue > 0 ? Math.round((rawValue / totalValue) * 100) / 100 : 0 },
    { label: "Graded", value: totalValue > 0 ? Math.round((gradedValue / totalValue) * 100) / 100 : 0 },
  ].filter((s) => s.value > 0);

  return { by_era: byEra, by_category: byCategory };
}

// ── Display Attributes (Pills) ──────────────────────────────────────────────

export type DisplayAttribute = { title: string; subtitle: string; icon: string };

export function computeDisplayAttributes(
  attrs: PortfolioAttributes,
  totalCards: number,
): DisplayAttribute[] {
  const pills: DisplayAttribute[] = [];

  if (attrs.vintagePercent > 0.4)
    pills.push({ title: "High Nostalgia", subtitle: `${pct(attrs.vintagePercent)} in pre-2003 sets`, icon: "clock.arrow.circlepath" });
  if (attrs.gradedPercent > 0.3)
    pills.push({ title: "Graded Collector", subtitle: `${pct(attrs.gradedPercent)} professionally graded`, icon: "star.fill" });
  if (attrs.topHoldingConcentration > 0.6)
    pills.push({ title: "Low Diversification", subtitle: `Top 3 = ${pct(attrs.topHoldingConcentration)} of value`, icon: "chart.pie" });
  if (attrs.grailDensity > 0.2)
    pills.push({ title: "Grail Dense", subtitle: `${Math.round(attrs.grailDensity * totalCards)} cards over $500`, icon: "diamond" });
  if (attrs.modernPercent > 0.5)
    pills.push({ title: "Modern Focus", subtitle: `${pct(attrs.modernPercent)} in recent sets`, icon: "bolt.fill" });
  if (attrs.setBreadth > 0.5)
    pills.push({ title: "Set Explorer", subtitle: "Cards across many sets", icon: "square.grid.3x3.fill" });
  if (attrs.avgGrade >= 9)
    pills.push({ title: "Gem Mint Bias", subtitle: `Avg grade ${attrs.avgGrade.toFixed(1)}`, icon: "star.fill" });

  return pills.slice(0, 6);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ── Insights ────────────────────────────────────────────────────────────────

export function computeInsights(attrs: PortfolioAttributes, identity: CollectorIdentity): string[] {
  const insights: string[] = [];

  if (attrs.vintagePercent > 0.5 && attrs.grailDensity > 0.2)
    insights.push("Your portfolio looks more like a curator's than a trader's.");
  if (attrs.topHoldingConcentration > 0.6)
    insights.push("A few big cards drive most of your value.");
  if (attrs.nostalgiaScore > 0.5 && attrs.modernPercent < 0.3)
    insights.push("You go for classic, hard-to-find cards over wide set coverage.");
  if (attrs.gradedPercent > 0.5)
    insights.push("Condition matters to you — you lean toward graded cards.");
  if (attrs.setBreadth > 0.6 && attrs.topHoldingConcentration < 0.4)
    insights.push("You collect wide — your portfolio covers a lot of different sets.");
  if (attrs.modernPercent > 0.6)
    insights.push("You stay close to what is new — modern sets fill most of your portfolio.");

  // Always include at least one insight based on the identity
  if (insights.length === 0) {
    insights.push(identity.explanation);
  }

  return insights.slice(0, 4);
}

// ── Collector Radar Profile ─────────────────────────────────────────────────
//
// Six "what kind of collector am I" axes. Designed to answer profile
// questions ("you collect like an investor-hunter") rather than to
// inventory-tag a portfolio. Japanese and Grail moved to badges below
// the radar — they're modifiers, not universal axes.

export type RadarProfile = {
  nostalgia: number;        // older-era weight (WOTC through XY)
  currentEra: number;       // SWSH+/SV/current promos
  slabFocus: number;        // % graded × grade quality
  marketHeat: number;       // chase cards: grails + secret/hyper rares + popular characters
  tasteProfile: number;     // art-driven rarities: IR, AA, FA, SIR
  collectionDepth: number;  // breadth × depth (set-builder behavior)
};

type PrintingMeta = {
  finish: string | null;
  rarity: string | null;
  language: string | null;
};

// Rarities that signal aesthetic/art-driven collecting.
const TASTE_RARITY_KEYWORDS = [
  "illustration rare", "art rare", "special illustration",
  "alt art", "alternate art", "full art",
];

// Chase rarities — secret/hyper/rainbow tier on top of taste rarities.
const CHASE_RARITY_KEYWORDS = [
  "secret rare", "hyper rare", "rainbow rare", "gold star",
];

// Pokemon names that drive market heat regardless of rarity.
// Lowercase exact-match against canonical_cards.subject.
const POPULAR_CHARACTERS = new Set([
  "charizard", "pikachu",
  "eevee", "vaporeon", "jolteon", "flareon",
  "espeon", "umbreon", "leafeon", "glaceon", "sylveon",
]);

function matchesAny(haystack: string | null | undefined, needles: string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

function isTasteRarity(rarity: string | null | undefined): boolean {
  return matchesAny(rarity, TASTE_RARITY_KEYWORDS);
}

function isChaseRarity(rarity: string | null | undefined): boolean {
  return matchesAny(rarity, CHASE_RARITY_KEYWORDS);
}

function isPopularCharacter(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return POPULAR_CHARACTERS.has(subject.toLowerCase().trim());
}

type RadarCardMeta = {
  year: number | null;
  set_name: string | null;
  subject: string | null;
};

export function computeRadarProfile(
  holdings: (HoldingInput & { printing_id?: string | null })[],
  cardMap: Map<string, RadarCardMeta>,
  printingMetaMap: Map<string, PrintingMeta>,
  priceMap: Map<string, number>,
): RadarProfile {
  if (holdings.length === 0) {
    return { nostalgia: 0, currentEra: 0, slabFocus: 0, marketHeat: 0, tasteProfile: 0, collectionDepth: 0 };
  }

  let totalQty = 0;
  let gradedQty = 0;
  let gradeNumericSum = 0;
  let gradeNumericCount = 0;
  let currentEraQty = 0;
  let nostalgiaWeighted = 0;       // age-weighted older-era contribution
  let tasteQty = 0;
  let chaseRarityQty = 0;
  let grailQty = 0;
  let popularCharacterQty = 0;
  const sets = new Set<string>();

  for (const h of holdings) {
    const qty = h.qty || 1;
    totalQty += qty;

    const meta = cardMap.get(h.canonical_slug);
    const year = meta?.year ?? null;

    // Nostalgia — weighted by age, capped. WOTC through XY (≤2016) gets
    // the strongest signal; SUM/SM (2017–2019) is mid; 2020+ contributes 0.
    if (year != null && year <= 2016) {
      const age = Math.max(0, 2026 - year);
      nostalgiaWeighted += Math.min(age / 25, 1) * qty;
    }

    // Current Era — SWSH onwards.
    if (year != null && year >= 2020) currentEraQty += qty;

    if (meta?.set_name) sets.add(meta.set_name);

    if (isGraded(h.grade)) {
      gradedQty += qty;
      const num = parseGradeNumeric(h.grade);
      if (num != null) { gradeNumericSum += num * qty; gradeNumericCount += qty; }
    }

    const printMeta = h.printing_id ? printingMetaMap.get(h.printing_id) : null;
    if (isTasteRarity(printMeta?.rarity)) tasteQty += qty;
    if (isChaseRarity(printMeta?.rarity)) chaseRarityQty += qty;

    const price = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade) ?? 0;
    if (price >= 500) grailQty += qty;

    if (isPopularCharacter(meta?.subject)) popularCharacterQty += qty;
  }

  const totalQtyDenom = Math.max(totalQty, 1);
  const nostalgia = Math.min(nostalgiaWeighted / totalQtyDenom, 1);
  const currentEra = currentEraQty / totalQtyDenom;

  // Slab Focus — combine prevalence with quality. 70% weight on % graded,
  // 30% on average grade (only counts if anything is graded). Pure raw
  // collection = 0; a portfolio of mostly PSA 10s = ~1.0.
  const gradedPct = gradedQty / totalQtyDenom;
  const avgGrade = gradeNumericCount > 0 ? gradeNumericSum / gradeNumericCount : 0;
  const slabFocus = Math.min(0.7 * gradedPct + 0.3 * (avgGrade / 10), 1);

  // Market Heat — chase signal aggregated across three sources:
  //   grail density (25%+ of collection at $500+ = full)
  //   chase rarities (secret/hyper/rainbow, 20%+ = full)
  //   popular characters (Charizard/Pikachu/Eeveelutions, 30%+ = full)
  // Take the max so a portfolio that's heavy on any one signal still
  // reads as Market Heat.
  const grailScore = Math.min((grailQty / totalQtyDenom) * 4, 1);
  const chaseRarityScore = Math.min((chaseRarityQty / totalQtyDenom) * 5, 1);
  const popularScore = Math.min((popularCharacterQty / totalQtyDenom) * 3.33, 1);
  const marketHeat = Math.max(grailScore, chaseRarityScore, popularScore);

  // Taste Profile — art-driven rarities. 30%+ = full score. Pure
  // expression of "do they collect for the art".
  const tasteProfile = Math.min((tasteQty / totalQtyDenom) * 3.33, 1);

  // Collection Depth — set-builder behavior. Combines depth (avg cards
  // per set) with breadth (number of distinct sets). 60/40 weight, both
  // capped: 8 cards/set × 10 sets = full score.
  const setCount = sets.size;
  const avgCardsPerSet = totalQty / Math.max(setCount, 1);
  const depthComponent = Math.min(avgCardsPerSet / 8, 1);
  const breadthComponent = Math.min(setCount / 10, 1);
  const collectionDepth = 0.6 * depthComponent + 0.4 * breadthComponent;

  return {
    nostalgia,
    currentEra,
    slabFocus,
    marketHeat,
    tasteProfile,
    collectionDepth,
  };
}

// ── Collector Badges ────────────────────────────────────────────────────────
//
// Badges are modifiers/identity labels surfaced below the radar. Unlike
// the radar (which always renders 6 axes), badges only appear when their
// thresholds are met — they're earned. This is the home for "Japanese
// Specialist" and "Grail Hunter", which used to be radar axes but are
// better expressed as modifiers since a user can hit them across any of
// the radar dimensions.

export type Badge = {
  id: BadgeId;
  label: string;
  description: string;
  icon: string; // SF Symbol name (used by iOS, ignored by web)
};

export type BadgeId =
  | "japanese_specialist"
  | "grail_hunter"
  | "binder_builder"
  | "slab_collector"
  | "modern_chase_collector"
  | "vintage_loyalist"
  | "art_first_collector"
  | "set_completionist";

type BadgeContext = {
  totalQty: number;
  jpQty: number;
  grailCount: number;     // count of holdings $500+
  gradedPct: number;
  setCount: number;
  avgCardsPerSet: number;
  radar: RadarProfile;
};

function buildBadgeContext(
  holdings: (HoldingInput & { printing_id?: string | null })[],
  cardMap: Map<string, RadarCardMeta>,
  printingMetaMap: Map<string, PrintingMeta>,
  priceMap: Map<string, number>,
  radar: RadarProfile,
): BadgeContext {
  let totalQty = 0;
  let jpQty = 0;
  let grailCount = 0;
  let gradedQty = 0;
  const sets = new Set<string>();

  for (const h of holdings) {
    const qty = h.qty || 1;
    totalQty += qty;

    const meta = cardMap.get(h.canonical_slug);
    if (meta?.set_name) sets.add(meta.set_name);

    const printMeta = h.printing_id ? printingMetaMap.get(h.printing_id) : null;
    if (printMeta?.language === "JP") jpQty += qty;

    if (isGraded(h.grade)) gradedQty += qty;

    const price = lookupHoldingPrice(priceMap, h.canonical_slug, h.grade) ?? 0;
    if (price >= 500) grailCount += qty;
  }

  const denom = Math.max(totalQty, 1);
  return {
    totalQty,
    jpQty,
    grailCount,
    gradedPct: gradedQty / denom,
    setCount: sets.size,
    avgCardsPerSet: totalQty / Math.max(sets.size, 1),
    radar,
  };
}

const BADGE_RULES: Array<{
  id: BadgeId;
  label: string;
  icon: string;
  qualifies: (ctx: BadgeContext) => boolean;
  describe: (ctx: BadgeContext) => string;
}> = [
  {
    id: "japanese_specialist",
    label: "Japanese Specialist",
    icon: "globe.asia.australia.fill",
    qualifies: (c) => c.totalQty > 0 && c.jpQty / c.totalQty >= 0.4,
    describe: (c) => `${pct(c.jpQty / c.totalQty)} of your collection is Japanese`,
  },
  {
    id: "grail_hunter",
    label: "Grail Hunter",
    icon: "diamond.fill",
    qualifies: (c) => c.grailCount >= 3 || (c.totalQty > 0 && c.grailCount / c.totalQty >= 0.15),
    describe: (c) => `${c.grailCount} cards over $500`,
  },
  {
    id: "binder_builder",
    label: "Binder Builder",
    icon: "books.vertical.fill",
    qualifies: (c) => c.radar.collectionDepth >= 0.6 && c.gradedPct < 0.3,
    describe: (c) => `${c.setCount} sets, mostly raw`,
  },
  {
    id: "slab_collector",
    label: "Slab Collector",
    icon: "rectangle.fill.on.rectangle.fill",
    qualifies: (c) => c.gradedPct >= 0.5,
    describe: (c) => `${pct(c.gradedPct)} graded`,
  },
  {
    id: "modern_chase_collector",
    label: "Modern Chase Collector",
    icon: "bolt.fill",
    qualifies: (c) => c.radar.currentEra >= 0.5 && c.radar.marketHeat >= 0.5,
    describe: () => "Heavy on current-era chase cards",
  },
  {
    id: "vintage_loyalist",
    label: "Vintage Loyalist",
    icon: "clock.arrow.circlepath",
    qualifies: (c) => c.radar.nostalgia >= 0.5 && c.radar.currentEra < 0.3,
    describe: () => "Strong pull toward older eras",
  },
  {
    id: "art_first_collector",
    label: "Art-First Collector",
    icon: "paintpalette.fill",
    qualifies: (c) => c.radar.tasteProfile >= 0.5,
    describe: () => "Illustration rares, alt arts, full arts",
  },
  {
    id: "set_completionist",
    label: "Set Completionist",
    icon: "checkmark.seal.fill",
    qualifies: (c) => c.radar.collectionDepth >= 0.7 && c.avgCardsPerSet >= 8,
    describe: (c) => `~${Math.round(c.avgCardsPerSet)} cards per set`,
  },
];

export function computeBadges(
  holdings: (HoldingInput & { printing_id?: string | null })[],
  cardMap: Map<string, RadarCardMeta>,
  printingMetaMap: Map<string, PrintingMeta>,
  priceMap: Map<string, number>,
  radar: RadarProfile,
): Badge[] {
  if (holdings.length === 0) return [];
  const ctx = buildBadgeContext(holdings, cardMap, printingMetaMap, priceMap, radar);
  return BADGE_RULES
    .filter((rule) => rule.qualifies(ctx))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      description: rule.describe(ctx),
      icon: rule.icon,
    }));
}

// ── Top Holdings ────────────────────────────────────────────────────────────

export type TopHoldingResult = {
  name: string;
  set_name: string;
  variant: string;
  current_value: number;
  change_pct: number;
  descriptor: string | null;
  image_url: string | null;
};

type EnrichedHolding = HoldingInput & {
  name: string;
  set_name: string;
  market_price: number;
  change_pct: number;
  image_url: string | null;
  position_value: number;
};

export function computeTopHoldings(
  holdings: HoldingInput[],
  cardMap: Map<string, { canonical_name: string; set_name: string | null; year: number | null }>,
  priceMap: Map<string, number>,
  changeMap: Map<string, number>,
  imageMap: Map<string, string>,
): TopHoldingResult[] {
  // Group by slug+grade, sum qty
  const groups = new Map<string, { slug: string; grade: string; qty: number; cost: number }>();
  for (const h of holdings) {
    const key = `${h.canonical_slug}::${h.grade}`;
    const g = groups.get(key) ?? { slug: h.canonical_slug, grade: h.grade, qty: 0, cost: 0 };
    g.qty += h.qty;
    g.cost += h.price_paid_usd * h.qty;
    groups.set(key, g);
  }

  const enriched: EnrichedHolding[] = [...groups.values()].map((g) => {
    const meta = cardMap.get(g.slug);
    const mp = lookupHoldingPrice(priceMap, g.slug, g.grade) ?? 0;
    return {
      canonical_slug: g.slug,
      qty: g.qty,
      grade: g.grade,
      price_paid_usd: g.cost / g.qty,
      name: meta?.canonical_name ?? g.slug,
      set_name: meta?.set_name ?? "Unknown",
      market_price: mp,
      change_pct: changeMap.get(g.slug) ?? 0,
      image_url: imageMap.get(g.slug) ?? null,
      position_value: mp * g.qty,
    };
  });

  enriched.sort((a, b) => b.position_value - a.position_value);

  // Assign descriptors
  let bestPerformerIdx = 0;
  for (let i = 1; i < enriched.length; i++) {
    if (enriched[i]!.change_pct > enriched[bestPerformerIdx]!.change_pct) bestPerformerIdx = i;
  }

  return enriched.slice(0, 5).map((h, i) => ({
    name: h.name,
    set_name: h.set_name,
    variant: h.grade,
    current_value: Math.round(h.position_value * 100) / 100,
    change_pct: Math.round(h.change_pct * 10) / 10,
    descriptor: i === 0 ? "Largest holding" : i === bestPerformerIdx ? "Best performer" : null,
    image_url: h.image_url,
  }));
}
