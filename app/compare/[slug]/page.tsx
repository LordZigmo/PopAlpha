import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllComparisonSlugs, getComparison } from "@/lib/compare/data";
import {
  breadcrumbSchema,
  faqPageSchema,
  softwareApplicationSchema,
} from "@/lib/compare/schema";
import JsonLd from "@/components/compare/json-ld";
import ComparisonHero from "@/components/compare/comparison-hero";
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
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0]">
      <JsonLd data={jsonLd} />

      <header className="mx-auto flex max-w-2xl items-center justify-between px-6 py-6">
        <Link href="/" aria-label="PopAlpha home" className="flex items-center">
          <Image
            src="/brand/popalpha-modern-white.png"
            alt="PopAlpha"
            width={840}
            height={182}
            className="h-8 w-auto"
          />
        </Link>
        <Link
          href="#waitlist"
          className="text-[14px] text-[#8A8A8E] transition-colors hover:text-white"
        >
          Join waitlist
        </Link>
      </header>

      <article className="mx-auto max-w-2xl px-6 pb-28 pt-6 sm:pt-10">
        <ComparisonHero h1={entry.h1} subtitle={entry.subtitle} lead={entry.quickAnswer} />
        <ComparisonTable
          caption={entry.tableCaption}
          competitorName={entry.competitorName}
          rows={entry.rows}
        />
        <HonestBreakdown sections={entry.breakdown} />
        <ComparisonFaq items={entry.faq} />
        <ComparisonCta cta={entry.cta} />

        <p className="mt-16 text-[14px] text-[#6B6B6B]">
          Updated {formatUpdated(entry.updated)} ·{" "}
          <Link
            href="/"
            className="text-[#8A8A8E] underline-offset-2 hover:text-white hover:underline"
          >
            popalpha.ai
          </Link>
        </p>
      </article>
    </div>
  );
}
