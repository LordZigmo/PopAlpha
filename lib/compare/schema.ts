import { getSiteUrl } from "@/lib/site-url";
import type { FaqItem } from "./types";

// schema.org JSON-LD builders. JSON-LD uses absolute URLs (page metadata uses
// relative paths). Structured data is built from the SAME data the page renders,
// so it always matches the visible content (per Google's guidance).

type JsonLdObject = Record<string, unknown>;

export function faqPageSchema(faq: FaqItem[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

export function breadcrumbSchema(
  items: { name: string; path: string }[],
): JsonLdObject {
  const base = getSiteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${base}${item.path}`,
    })),
  };
}

// PopAlpha as a free iOS app. No aggregateRating/reviewCount — we have no review
// corpus, and fabricated ratings risk a manual penalty.
export function softwareApplicationSchema(): JsonLdObject {
  const base = getSiteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "PopAlpha",
    applicationCategory: "FinanceApplication",
    operatingSystem: "iOS",
    description:
      "PopAlpha is a free Pokémon card scanner with market intelligence — English and Japanese card prices, AI market summaries, and daily market signals.",
    url: base,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}
