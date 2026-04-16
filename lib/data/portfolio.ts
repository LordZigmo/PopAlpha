import "server-only";

/**
 * Portfolio analysis library.
 *
 * Computes collector identity, composition, attributes, top holdings,
 * and heuristic insights from raw holdings + market data.
 */

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

    const marketPrice = priceMap.get(h.canonical_slug) ?? h.price_paid_usd;
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
  grail_hunter: "Your portfolio centers on high-value chase cards. You prefer conviction over diversification, targeting the cards other collectors dream about.",
  set_finisher: "You approach collecting with completionist discipline. Your portfolio shows methodical progress toward filling out the sets you care about.",
  nostalgia_curator: "You favor iconic legacy cards with emotional and historical weight over broad diversification. Your portfolio suggests deliberate taste rather than pure speculation.",
  modern_momentum: "You stay close to the current meta, building positions in new releases and emerging chase cards before the wider market catches on.",
  trophy_collector: "Your collection reads like a highlight reel. You invest in statement pieces — the cards that define collections and turn heads.",
  market_opportunist: "You collect with a trader's eye, spotting undervalued opportunities across eras and categories. Your portfolio is built on market awareness.",
  completionist: "You cast a wide net, building broad coverage across sets and eras. Your collection values breadth and the joy of discovery.",
  graded_purist: "Condition is everything to you. Your portfolio skews heavily toward professionally graded cards, with a clear preference for top grades.",
  binder_builder: "You collect for the tangible experience. Your portfolio is raw-heavy, focused on building a physical collection you can hold and enjoy.",
  sealed_strategist: "You treat sealed product as a long-term asset. Your allocation toward unopened product suggests patience and a belief in future demand.",
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
    const price = priceMap.get(h.canonical_slug) ?? h.price_paid_usd;
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
    insights.push("Your portfolio is more curator-driven than investor-driven.");
  if (attrs.topHoldingConcentration > 0.6)
    insights.push("Your gains are driven by a small number of high-conviction cards.");
  if (attrs.nostalgiaScore > 0.5 && attrs.modernPercent < 0.3)
    insights.push("You prefer iconic scarcity over set breadth.");
  if (attrs.gradedPercent > 0.5)
    insights.push("You lean into condition as a value driver.");
  if (attrs.setBreadth > 0.6 && attrs.topHoldingConcentration < 0.4)
    insights.push("You collect broadly — your portfolio is well-diversified across sets.");
  if (attrs.modernPercent > 0.6)
    insights.push("You're positioned in the current meta — modern releases dominate your portfolio.");

  // Always include at least one insight based on the identity
  if (insights.length === 0) {
    insights.push(identity.explanation);
  }

  return insights.slice(0, 4);
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
    const mp = priceMap.get(g.slug) ?? 0;
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
