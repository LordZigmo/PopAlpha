import type { FaqItem } from "@/lib/compare/types";
import type { PriceDisplay } from "@/lib/pricing/displayed-market-price";

/**
 * Builds the crawlable, GEO-friendly "About this card" copy + FAQ for a card
 * detail page, plus the single price (if any) that is safe to publish in
 * Product/AggregateOffer structured data.
 *
 * Honesty is the whole point: the price language and `offerPrice` are gated on
 * the SAME `resolveDisplayedMarketPrice` classification the rest of the app uses
 * (and that the OG image enforces). We never state — in visible copy OR in
 * structured data — a price the page itself wouldn't stand behind. `stale_old`
 * may be quoted visibly as a "last sold" figure but is NOT emitted as an offer.
 */
export type CardSeoInput = {
  name: string;
  setName: string | null;
  cardNumber: string | null;
  year: number | null;
  rarity: string | null;
  subject: string | null;
  /** Raw/ungraded price classification — the canonical "what's it worth" signal. */
  priceDisplay: PriceDisplay;
};

export type CardSeoContent = {
  /** One-paragraph identity + price sentence. Always non-empty. */
  introSentence: string;
  faq: FaqItem[];
  /**
   * USD price safe to emit in Product/AggregateOffer JSON-LD, or null when the
   * market is too stale/sparse to vouch for a current value.
   */
  offerPrice: number | null;
};

function formatUsd(n: number): string {
  // Mirror the card-page headline formatter (formatUsdCompact in
  // app/c/[slug]/page.tsx): 2 decimals below $1,000, whole dollars at/above. This
  // keeps the visible "About this card" prose identical to the headline and never
  // reads as inflated relative to the exact-value AggregateOffer (e.g. $250.99 —
  // not "$251" — for a card whose offer is 250.99).
  const whole = n >= 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(n);
}

function formatAsOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** A standalone price statement keyed on the card name, reused for intro + FAQ. */
function buildPriceStatement(
  name: string,
  priceDisplay: PriceDisplay,
): { statement: string; offerPrice: number | null } {
  switch (priceDisplay.kind) {
    case "live":
      return {
        statement: `As of ${formatAsOf(priceDisplay.asOf)}, ${name} has an estimated raw (ungraded) market price of ${formatUsd(priceDisplay.price)}.`,
        offerPrice: priceDisplay.price,
      };
    case "abundant":
      return {
        statement: `${name} is a low-dollar card, trading around ${formatUsd(priceDisplay.price)} ungraded as of ${formatAsOf(priceDisplay.asOf)}.`,
        offerPrice: priceDisplay.price,
      };
    case "stale_recent":
      return {
        statement: `${name} most recently traded around ${formatUsd(priceDisplay.price)} ungraded (${priceDisplay.ageLabel}).`,
        offerPrice: priceDisplay.price,
      };
    case "stale_old":
      return {
        statement: `${name} last sold for about ${formatUsd(priceDisplay.price)} ungraded (${priceDisplay.ageLabel}), though its market is currently sparse.`,
        offerPrice: null,
      };
    case "no_market":
      return {
        statement: `A reliable current market price for ${name} isn't available yet — recent sales are too sparse to quote a confident value.`,
        offerPrice: null,
      };
  }
}

function buildIdentitySentence(input: CardSeoInput): string {
  let s = `${input.name} is a Pokémon trading card`;
  if (input.setName) s += ` from the ${input.setName} set`;
  if (input.year) s += ` (${input.year})`;
  if (input.cardNumber) s += `, card #${input.cardNumber}`;
  return `${s}.`;
}

export function buildCardSeoContent(input: CardSeoInput): CardSeoContent {
  const price = buildPriceStatement(input.name, input.priceDisplay);
  const introSentence = `${buildIdentitySentence(input)} ${price.statement}`;

  const faq: FaqItem[] = [];

  faq.push({
    question: `How much is ${input.name}${input.setName ? ` (${input.setName})` : ""} worth?`,
    answer: price.statement,
  });

  if (input.setName) {
    const numberClause = input.cardNumber ? ` card #${input.cardNumber}` : "";
    const yearClause = input.year ? `, released in ${input.year}` : "";
    faq.push({
      question: `What set is ${input.name} from?`,
      answer: `${input.name} is${numberClause} from the ${input.setName} set${yearClause}.`,
    });
  }

  if (input.rarity) {
    faq.push({
      question: `Is ${input.name} rare?`,
      answer: `In the Pokémon TCG, ${input.name} has a rarity of "${input.rarity}".`,
    });
  }

  return { introSentence, faq, offerPrice: price.offerPrice };
}
