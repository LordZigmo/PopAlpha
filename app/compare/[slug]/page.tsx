import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllComparisonSlugs, getComparison } from "@/lib/compare/data";
import {
  breadcrumbSchema,
  faqPageSchema,
  softwareApplicationSchema,
} from "@/lib/compare/schema";
import JsonLd from "@/components/compare/json-ld";
import ComparisonHero from "@/components/compare/comparison-hero";
import QuickAnswerBox from "@/components/compare/quick-answer-box";
import ComparisonTable from "@/components/compare/comparison-table";
import HonestBreakdown from "@/components/compare/honest-breakdown";
import ComparisonFaq from "@/components/compare/comparison-faq";
import ComparisonCta from "@/components/compare/comparison-cta";

// Only the known comparison slugs are pre-rendered; anything else 404s.
export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return getAllComparisonSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = getComparison(slug);

  if (!entry) {
    return {
      title: "Comparison Not Found | PopAlpha",
      robots: { index: false, follow: false },
    };
  }

  const canonicalPath = `/compare/${entry.slug}`;
  return {
    title: entry.metaTitle,
    description: entry.metaDescription,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title: entry.metaTitle,
      description: entry.metaDescription,
      url: canonicalPath,
      siteName: "PopAlpha",
      type: "website",
      images: [{ url: "/opengraph-image", alt: "PopAlpha" }],
    },
    twitter: {
      card: "summary_large_image",
      title: entry.metaTitle,
      description: entry.metaDescription,
      images: ["/twitter-image"],
    },
  };
}

export default async function ComparePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getComparison(slug);
  if (!entry) notFound();

  // Only the head-to-head ("versus") layout is populated today. Listicle entries
  // arrive in the expansion pass; until then there are none of that kind to render.
  if (entry.kind !== "versus") notFound();

  const jsonLd = [
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: entry.h1, path: `/compare/${entry.slug}` },
    ]),
    faqPageSchema(entry.faq),
    softwareApplicationSchema(),
  ];

  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <JsonLd data={jsonLd} />
      <div className="mx-auto max-w-4xl">
        <ComparisonHero eyebrow={entry.eyebrow} h1={entry.h1} updated={entry.updated} />
        <QuickAnswerBox text={entry.quickAnswer} />
        <ComparisonTable
          caption={entry.tableCaption}
          competitorName={entry.competitorName}
          rows={entry.rows}
        />
        <HonestBreakdown sections={entry.breakdown} />
        <ComparisonFaq items={entry.faq} />
        <ComparisonCta cta={entry.cta} />
      </div>
    </main>
  );
}
