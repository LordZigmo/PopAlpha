import { getSiteUrl } from "@/lib/site-url";

// schema.org JSON-LD builders for the catalog + marketing surfaces. JSON-LD uses
// absolute URLs (page metadata uses relative paths). Every value here is built
// from the SAME data the page renders, so structured data always matches the
// visible content (per Google's guidance). Render with `@/components/compare/json-ld`.
//
// Breadcrumb + FAQ builders live in `@/lib/compare/schema` and are reused as-is.

type JsonLdObject = Record<string, unknown>;

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export type CardProductSchemaInput = {
  /** Display name, e.g. "Umbreon ex · Prismatic Evolutions · #161". */
  name: string;
  slug: string;
  description: string;
  imageUrl: string | null;
  setName: string | null;
  cardNumber: string | null;
  rarity: string | null;
  year: number | null;
  /**
   * USD price to publish as the card's market value, or null to omit `offers`
   * entirely. Caller is responsible for honesty-gating this (see
   * `buildCardSeoContent`); we only re-check it is a positive finite number.
   */
  offerPrice: number | null;
};

export function cardProductSchema(input: CardProductSchemaInput): JsonLdObject | null {
  const price =
    input.offerPrice != null && Number.isFinite(input.offerPrice) && input.offerPrice > 0
      ? Math.round(input.offerPrice * 100) / 100
      : null;

  // Google's Product snippet requires one of offers / review / aggregateRating.
  // We have no review corpus, so without an honest, publishable price there is
  // nothing valid to assert — omit the Product entirely rather than emit one that
  // would only generate "missing offers" warnings across the sparse/stale long tail.
  if (price === null) return null;

  const base = getSiteUrl();
  const additionalProperty = [
    input.setName ? { "@type": "PropertyValue", name: "Set", value: input.setName } : null,
    input.cardNumber ? { "@type": "PropertyValue", name: "Card Number", value: input.cardNumber } : null,
    input.rarity ? { "@type": "PropertyValue", name: "Rarity", value: input.rarity } : null,
    input.year ? { "@type": "PropertyValue", name: "Year", value: String(input.year) } : null,
  ].filter(Boolean);

  const schema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    description: input.description,
    category: "Pokémon Trading Card",
    brand: { "@type": "Brand", name: "Pokémon" },
    url: `${base}/c/${encodeURIComponent(input.slug)}`,
    // AggregateOffer (not Offer): PopAlpha aggregates observed market value across
    // sources and does NOT sell cards, so there is no seller/availability to claim.
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: price,
      highPrice: price,
    },
  };

  if (isHttpUrl(input.imageUrl)) schema.image = input.imageUrl;
  if (additionalProperty.length > 0) schema.additionalProperty = additionalProperty;

  return schema;
}

export function organizationSchema(): JsonLdObject {
  const base = getSiteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "PopAlpha",
    url: base,
    logo: `${base}/icon`,
    description:
      "PopAlpha is a Pokémon card scanner and market-intelligence app — instant card identification with English and Japanese pricing, graded values, and daily market signals.",
  };
}

export function webSiteSchema(): JsonLdObject {
  const base = getSiteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "PopAlpha",
    url: base,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${base}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}
