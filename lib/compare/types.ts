// Typed model for the /compare/* marketing pages. The shape supports both a
// head-to-head ("PopAlpha vs X") layout and a ranked "best of" listicle layout
// so all of the planned comparison pages can share one template. Only the
// "versus" kind is populated today; "listicle" is reserved for the next pass.

export type FaqItem = {
  question: string;
  /** Plain text — rendered visibly AND used to build FAQPage JSON-LD, so the two must match. */
  answer: string;
};

export type BreakdownSection = {
  heading: string;
  paragraphs: string[];
};

export type CtaCopy = {
  heading: string;
  body: string;
  /** Optional secondary link. Unused while the app is waitlist-only. */
  secondary?: {
    label: string;
    href: string;
  };
};

/** External citation shown in the page's "Sources" list. Competitor links use nofollow. */
export type ComparisonSource = {
  label: string;
  url: string;
  /** Adds rel="nofollow" — for competitor pages we cite but don't endorse. */
  nofollow?: boolean;
};

type ComparisonBase = {
  /** URL slug, no leading slash, e.g. "popalpha-vs-collectr". */
  slug: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  /** One-line question / positioning shown under the title. */
  subtitle: string;
  /** 2–4 sentence lead paragraph — also the featured-snippet / LLM-extract target. */
  quickAnswer: string;
  breakdown: BreakdownSection[];
  faq: FaqItem[];
  cta: CtaCopy;
  /** Slugs of sibling comparison pages to cross-link. Empty until more pages exist. */
  related: string[];
  /** ISO date (YYYY-MM-DD); shown as "Updated …" and used for sitemap lastModified. */
  updated: string;
  /** Optional external citations (e.g., a competitor's own pricing page backing a stated figure). */
  sources?: ComparisonSource[];
};

/** Head-to-head: "PopAlpha vs <competitor>". */
export type VersusRow = {
  feature: string;
  /** Visible cell text. Honest, can be a phrase ("Yes — unlimited"). */
  popalpha: string;
  /** Visible cell text. Kept general/defensible — no invented checkmarks or prices. */
  competitor: string;
};

export type VersusComparison = ComparisonBase & {
  kind: "versus";
  competitorName: string;
  competitorDescriptor: string;
  tableCaption: string;
  rows: VersusRow[];
};

/** Ranked "best of" listicle. Reserved for the expansion pass — not populated yet. */
export type ListicleApp = {
  rank: number;
  name: string;
  isPopAlpha?: boolean;
  oneLiner: string;
  bestFor: string;
  notes: string[];
};

export type ListicleComparison = ComparisonBase & {
  kind: "listicle";
  intro: string;
  apps: ListicleApp[];
};

export type ComparisonEntry = VersusComparison | ListicleComparison;
