import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllComparisonSlugs, getComparison } from "@/lib/compare/data";
import {
  breadcrumbSchema,
  faqPageSchema,
  itemListSchema,
  softwareApplicationSchema,
} from "@/lib/compare/schema";
import CompareShell from "@/components/compare/compare-shell";
import JsonLd from "@/components/compare/json-ld";
import ComparisonHero from "@/components/compare/comparison-hero";
import ComparisonTable from "@/components/compare/comparison-table";
import ListicleList from "@/components/compare/listicle-list";
import HonestBreakdown from "@/components/compare/honest-breakdown";
import ComparisonFaq from "@/components/compare/comparison-faq";
import ComparisonCta from "@/components/compare/comparison-cta";
import CompareCrossLinks from "@/components/compare/compare-cross-links";

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

function formatUpdated(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function ComparePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getComparison(slug);
  if (!entry) notFound();

  const jsonLd: Record<string, unknown>[] = [
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "Compare", path: "/compare" },
      { name: entry.h1, path: `/compare/${entry.slug}` },
    ]),
    faqPageSchema(entry.faq),
    softwareApplicationSchema(),
  ];
  if (entry.kind === "listicle") {
    jsonLd.push(itemListSchema(entry.apps.map((app) => app.name)));
  }

  return (
    <CompareShell
      footnote={
        <>
          Updated {formatUpdated(entry.updated)} ·{" "}
          <Link
            href="/compare"
            className="text-[#8A8A8E] underline-offset-2 hover:text-white hover:underline"
          >
            More comparisons
          </Link>
        </>
      }
    >
      <JsonLd data={jsonLd} />
      <ComparisonHero h1={entry.h1} subtitle={entry.subtitle} lead={entry.quickAnswer} />

      {entry.kind === "versus" ? (
        <ComparisonTable
          caption={entry.tableCaption}
          competitorName={entry.competitorName}
          rows={entry.rows}
        />
      ) : (
        <section className="mt-12">
          <p className="text-[18px] leading-8 text-[#A8A8A8]">{entry.intro}</p>
          <ListicleList apps={entry.apps} />
        </section>
      )}

      <HonestBreakdown sections={entry.breakdown} />
      <ComparisonFaq items={entry.faq} />
      <ComparisonCta cta={entry.cta} />
      <CompareCrossLinks currentSlug={entry.slug} related={entry.related} />
    </CompareShell>
  );
}
