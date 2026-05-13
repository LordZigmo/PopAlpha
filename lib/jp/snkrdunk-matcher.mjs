/**
 * Snkrdunk listing matcher / aggregator.
 *
 * Distinct from lib/jp/matcher.mjs (Yahoo!) because Snkrdunk's data is
 * already structured at the source:
 *
 *   - Each Snkrdunk product ID (SW---<id>) corresponds to one specific
 *     printing of one specific physical card. There's no per-listing
 *     finish disambiguation to do — the product URL pre-resolves it.
 *
 *   - Each listing has a `condition` enum (A/B/C/D/PSA 10/...) — no
 *     title parsing needed for grade extraction. Yahoo!'s extractGrade
 *     + extractFinish regex chain doesn't apply.
 *
 *   - Each listing has an `isSold` boolean — sold listings are the
 *     market-clearing signal we want; active asks are noise. We filter
 *     to sold-only here so downstream code can stay shape-agnostic.
 *
 * Out of scope for this file:
 *
 *   - Mapping a Snkrdunk product → canonical_slug. That's a one-time
 *     per-product decision handled by the orchestrator (Step 4) using
 *     the Snkrdunk product's English name (e.g. "Charizard VMAX HR:
 *     PROMO[S-P 104](S-P Promotional cards)") matched against our
 *     canonical_cards table. Once mapped, the result is persisted —
 *     we don't re-run product matching every refresh.
 *
 *   - Currency conversion. Snkrdunk's English site reports USD directly;
 *     this file passes the price through with the listing's stated
 *     currency. The orchestrator decides whether to trust Snkrdunk's
 *     USD or re-derive from a JPY source for cross-source consistency
 *     with the Yahoo! pipeline.
 */

// =============================================================================
// Condition → grade mapping
// =============================================================================
/**
 * Map Snkrdunk's condition enum to our internal grade taxonomy.
 *
 * Snkrdunk's full condition set (verified from
 * /en/v1/streetwears/used-listings/conditions and from listing samples):
 *
 *   Raw:        "A"  "B"  "C"  "D"
 *   PSA:        "PSA 10"  "PSA 9"  "PSA 8 or under"
 *   BGS:        "BGS 10 BL"  "BGS 10 GL"  "BGS 9.5"  "BGS 9 or under"
 *   ARS:        "ARS 10(+)"  "ARS 10"  "ARS 9"  "ARS 8 or under"
 *   Other:      "Other Graded"
 *
 * v0 mapping is deliberately conservative. We map to grade labels that
 * exist in our grade_definitions / grade_aliases catalog today and skip
 * everything else, rather than churn the catalog at the same time as
 * launching the source. The trade-off: we leave signal on the floor (a
 * PSA 9 Charizard at $X is real market data) but ship cleanly without
 * blocking on grade-catalog expansion.
 *
 * Buckets currently kept:
 *   - A → RAW    (Snkrdunk's "Mint" — like-new, the closest analog to
 *                 our ungraded mint signal)
 *   - B → RAW    (Snkrdunk's "Near Mint" — most common raw condition)
 *   - PSA 10 → PSA10  (already in catalog from PR #44)
 *
 * Buckets currently dropped (returned label: null):
 *   - C, D                        — too damaged to bucket as RAW
 *                                   without diluting the median; might
 *                                   add RAW_C / RAW_D rows once we know
 *                                   sample volume.
 *   - PSA 9, PSA 8 or under       — common in JP graded market; v1 priority
 *   - BGS 10 BL, BGS 10 GL        — premium grades, often 1.5-2x PSA 10;
 *                                   v1 priority once we can write BGS_*
 *                                   rows.
 *   - BGS 9.5, BGS 9 or under     — same.
 *   - ARS *                       — ARS is a JP-specific grader; would
 *                                   need new catalog rows.
 *   - Other Graded                — too ambiguous to bucket.
 *
 * Future expansion: any new buckets here MUST also be added to
 * grade_definitions or grade_aliases or yahoo_jp_card_prices_grade_id_check
 * will reject them. See docs/schema-audit-2026-05-08.md §8 for the
 * grade-catalog expansion pattern.
 */
export function mapConditionToGrade(condition) {
  if (typeof condition !== "string") {
    return { company: null, grade: null, raw: null, label: null, supported: false };
  }
  const c = condition.trim();
  switch (c) {
    // Raw — buckets we keep
    case "A":
    case "B":
      return { company: null, grade: null, raw: true, label: "RAW", supported: true };

    // Graded — buckets we keep
    case "PSA 10":
      return { company: "PSA", grade: 10, raw: false, label: "PSA10", supported: true };

    // Raw — buckets we explicitly drop (track for telemetry)
    case "C":
    case "D":
      return { company: null, grade: null, raw: true, label: null, supported: false, droppedReason: "raw-condition-below-B" };

    // Graded — buckets we explicitly drop (v1 candidates)
    case "PSA 9":
    case "PSA 8 or under":
    case "BGS 10 BL":
    case "BGS 10 GL":
    case "BGS 9.5":
    case "BGS 9 or under":
    case "ARS 10(+)":
    case "ARS 10":
    case "ARS 9":
    case "ARS 8 or under":
    case "Other Graded":
      return { company: null, grade: null, raw: false, label: null, supported: false, droppedReason: `graded-not-in-v0-catalog (${c})` };

    default:
      // Unknown condition string — surface in warnings so we notice when
      // Snkrdunk adds a new bucket (or our parsing drifts).
      return { company: null, grade: null, raw: null, label: null, supported: false, droppedReason: `unknown-condition (${c})` };
  }
}

// =============================================================================
// Hard-exclusion filter
// =============================================================================
/**
 * Drop Snkrdunk listings that shouldn't feed price aggregation:
 *   - Bulk lots (numberOfItems > 1) — these are bundle prices, not per-card
 *   - Missing or non-positive price
 *   - Missing condition
 *   - isSold=false (active listings are asking-prices, not market-clearing)
 *
 * Note we DON'T filter on condition support here — caller wants to count
 * dropped-by-condition for telemetry separately from dropped-by-shape.
 */
export function applyHardExclusions(listings) {
  return listings.filter((l) => {
    if (typeof l.price !== "number" || l.price <= 0) return false;
    if (typeof l.condition !== "string" || l.condition.length === 0) return false;
    if (l.numberOfItems && l.numberOfItems > 1) return false;
    if (l.isSold !== true) return false;
    return true;
  });
}

// =============================================================================
// Aggregation
// =============================================================================
/**
 * Aggregate a list of Snkrdunk listings (post-scrape) into price
 * observations bucketed by grade.
 *
 * Input shape (per listing): output of scrape-snkrdunk.mjs normalizeListing
 * — must have: condition, price, currency, isSold, numberOfItems.
 *
 * Output shape (mirrors lib/jp/matcher.mjs selectMatched for orchestrator
 * compatibility):
 * {
 *   canonicalSlug: <passed-through opts.canonicalSlug>,
 *   inputCount: N,
 *   afterExclusion: N,
 *   accepted: N,
 *   priceObservations: [
 *     { grade: "RAW",   count, median, p25, p75, min, max, currency, samples: [...] },
 *     { grade: "PSA10", count, median, p25, p75, min, max, currency, samples: [...] },
 *   ],
 *   droppedConditions: { "C": 5, "PSA 9": 3, ... },  // for telemetry / v1 prioritization
 *   warnings: [...]
 * }
 *
 * The shape intentionally aligns with selectMatched's output so the
 * orchestrator can call either matcher and feed the same writer.
 *
 * Per-printing: each Snkrdunk product is already one printing, so we
 * emit observations with `printing_id = opts.printingId` (one value
 * provided by caller). No splitting required.
 */
export function aggregateSnkrdunkListings(listings, opts = {}) {
  const canonicalSlug = opts.canonicalSlug ?? null;
  const printingId = opts.printingId ?? null;

  const inputCount = listings.length;
  const filtered = applyHardExclusions(listings);

  // Bucket by grade label, tracking dropped conditions for telemetry.
  const droppedConditions = {};
  const byGrade = new Map();
  for (const listing of filtered) {
    const grade = mapConditionToGrade(listing.condition);
    if (!grade.supported || !grade.label) {
      droppedConditions[listing.condition] = (droppedConditions[listing.condition] ?? 0) + 1;
      continue;
    }
    if (!byGrade.has(grade.label)) byGrade.set(grade.label, []);
    byGrade.get(grade.label).push({ listing, grade });
  }

  const priceObservations = [];
  let accepted = 0;

  // Build one observation object per (grade, printing_id) combination.
  // For Snkrdunk, since one product = one printing, we emit at most two
  // rows per grade:
  //   - per-printing (printing_id = printingId)  — primary
  //   - canonical-rollup (printing_id = null)    — fallback for iOS view's
  //                                                COALESCE pattern
  //
  // When printingId is null (orchestrator hasn't resolved the printing
  // yet), we emit ONE row with printing_id=null — don't duplicate it.
  for (const [label, group] of byGrade) {
    const prices = group.map((s) => s.listing.price).filter((p) => typeof p === "number" && p > 0);
    if (prices.length === 0) continue;
    prices.sort((a, b) => a - b);

    // Currency: all listings in a group share a product, which has a
    // single currency. Use the first listing's currency; if mixed
    // (shouldn't happen), surface a warning below.
    const currencies = new Set(group.map((s) => s.listing.currency).filter(Boolean));
    const currency = currencies.size === 1 ? [...currencies][0] : null;

    const stats = {
      grade: label,
      finish: null,
      count: prices.length,
      median: prices[Math.floor(prices.length / 2)],
      p25: prices[Math.floor(prices.length * 0.25)],
      p75: prices[Math.floor(prices.length * 0.75)],
      min: prices[0],
      max: prices[prices.length - 1],
      currency,
      mixedCurrencies: currencies.size > 1,
      samples: group.slice(0, 5).map((s) => ({
        listingId: s.listing.listingId,
        listingUID: s.listing.listingUID,
        price: s.listing.price,
        currency: s.listing.currency,
        condition: s.listing.condition,
        isSold: s.listing.isSold,
      })),
    };

    if (printingId) {
      priceObservations.push({ ...stats, printing_id: printingId });
      priceObservations.push({ ...stats, printing_id: null });
    } else {
      priceObservations.push({ ...stats, printing_id: null });
    }
    accepted += prices.length;
  }

  // Sort: RAW first, then by grade label descending. Within a grade,
  // per-printing row before canonical-rollup so callers that iterate
  // sequentially get the more-specific data first. Matches selectMatched.
  priceObservations.sort((a, b) => {
    if (a.grade === "RAW" && b.grade !== "RAW") return -1;
    if (b.grade === "RAW" && a.grade !== "RAW") return 1;
    if (a.grade !== b.grade) return b.grade.localeCompare(a.grade);
    if (a.printing_id && !b.printing_id) return -1;
    if (b.printing_id && !a.printing_id) return 1;
    return 0;
  });

  const warnings = [];
  if (inputCount === 0) warnings.push("scraper returned zero listings");
  if (filtered.length === 0 && inputCount > 0) warnings.push("all listings excluded (active-only, lots, or missing price/condition)");
  if (accepted === 0 && filtered.length > 0) warnings.push("all filtered listings dropped by unsupported condition — review droppedConditions");
  const rawObs = priceObservations.find((o) => o.grade === "RAW" && o.printing_id === printingId);
  if (rawObs && rawObs.count < 3) warnings.push(`only ${rawObs.count} raw price points — low confidence`);
  // Mixed-currency check: should never happen in practice, but it would
  // be a critical correctness bug (¥3000 ≠ $3000), so surface loudly.
  if (priceObservations.some((o) => o.mixedCurrencies)) {
    warnings.push("MIXED CURRENCIES IN SINGLE GRADE BUCKET — investigate scraper output");
  }

  return {
    canonicalSlug,
    printingId,
    inputCount,
    afterExclusion: filtered.length,
    accepted,
    priceObservations,
    droppedConditions,
    warnings,
  };
}

// =============================================================================
// Product-name parsing (catalog-mapping helper)
// =============================================================================
/**
 * Parse a Snkrdunk product `name` field into structured components for
 * catalog matching. The Snkrdunk format is consistent:
 *
 *   Promo:  "Charizard VMAX HR: PROMO[S-P 104](S-P Promotional cards)"
 *           "Blastoise: Old Back/PROMO[PMCG-P No.009](PMCG-P Promotional cards)"
 *
 *   Set:    "Charizard VMAX RR [074/073](Sword & Shield \"Champion's Path\")"
 *           "Pikachu [025/214](Sun & Moon Promo)"
 *
 * Returns:
 * {
 *   pokemonName: "Charizard VMAX HR" | "Charizard VMAX RR",
 *   setCode:     "S-P" | "PMCG-P" | null,
 *   cardNumber:  "104" | "No.009" | "074/073" | "025/214",
 *   setLongName: "S-P Promotional cards" | "Sword & Shield Champion's Path",
 *   isPromo:     boolean (set name contains "Promo" or has "/PROMO" prefix),
 *   rawName:     <original>,
 * }
 *
 * This is best-effort; some products won't parse cleanly. The orchestrator
 * should fall back to fuzzy matching against canonical_cards when parsing
 * fails, surfaced as a "needs review" entry rather than silently mismatched.
 */
export function parseSnkrdunkProductName(name) {
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }
  const raw = name.trim();

  // Format A (Promo): "<Pokemon>: PROMO[<setCode> <number>](<setLongName>)"
  //                or "<Pokemon>: Old Back/PROMO[<setCode> <number>](<setLongName>)"
  const promoMatch = raw.match(/^(.+?):\s*(?:Old Back\/)?PROMO\[([^\s\]]+)\s+([^\]]+)\]\(([^)]+)\)\s*$/);
  if (promoMatch) {
    return {
      pokemonName: promoMatch[1].trim(),
      setCode: promoMatch[2].trim(),
      cardNumber: promoMatch[3].trim(),
      setLongName: promoMatch[4].trim(),
      isPromo: true,
      rawName: raw,
    };
  }

  // Format B (Set): "<Pokemon> [<number>](<setLongName>)"
  //   The setLongName may itself contain parens around a sub-set name —
  //   handle quoted ("Champion's Path") and unquoted variants.
  const setMatch = raw.match(/^(.+?)\s+\[([^\]]+)\]\(([^)]+)\)\s*$/);
  if (setMatch) {
    return {
      pokemonName: setMatch[1].trim(),
      setCode: null,
      cardNumber: setMatch[2].trim(),
      setLongName: setMatch[3].trim(),
      isPromo: /promo/i.test(setMatch[3]),
      rawName: raw,
    };
  }

  // Unparseable — return raw for caller's fallback handling.
  return {
    pokemonName: null,
    setCode: null,
    cardNumber: null,
    setLongName: null,
    isPromo: /promo/i.test(raw),
    rawName: raw,
  };
}
