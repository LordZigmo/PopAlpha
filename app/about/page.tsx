import type { Metadata } from "next";

const title = "About | PopAlpha";
const description = "What PopAlpha tracks, how the data works, and what the platform is building.";
const canonicalPath = "/about";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: canonicalPath,
  },
  openGraph: {
    title,
    description,
    url: canonicalPath,
    siteName: "PopAlpha",
    type: "website",
    images: [
      { url: "/opengraph-image", alt: "PopAlpha" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/twitter-image"],
  },
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            About PopAlpha
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px] lg:text-[48px]">
            Understand Pokemon Card Prices Fast
          </h1>
          <div className="mt-6 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>
              If you&apos;ve ever stood at a card show with your phone out, flipping between eBay listings and price charts, you know the feeling.
            </p>
            <div>
              <p>You&apos;re trying to figure out:</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li className="pl-1">Is this a fair price?</li>
                <li className="pl-1">Is this card trending up?</li>
                <li className="pl-1">Why is this version more expensive?</li>
                <li className="pl-1">Am I about to overpay?</li>
              </ul>
            </div>
            <p>We&apos;ve felt that pain too.</p>
            <p>
              Sometimes you don&apos;t just want a list of past sales. You want the vibe of the card. Is it hot? Quiet? Undervalued? Overhyped?
            </p>
            <p>PopAlpha was built to give you that answer in seconds.</p>
          </div>
        </div>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <h2 className="text-[30px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[44px]">
            Built For Singles Collectors
          </h2>
          <div className="mt-4 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>Right now, we focus on raw Pokemon card singles.</p>
            <p>
              Each version of a card, Holo, Non-Holo, 1st Edition, Shadowless, acts differently in the market. So we treat them differently.
            </p>
            <div>
              <p>PopAlpha tracks:</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li className="pl-1">Real Pokemon card sale prices</li>
                <li className="pl-1">Variant-specific price changes</li>
                <li className="pl-1">Market trends</li>
                <li className="pl-1">A Market Balance Price (our estimate of what&apos;s fair right now)</li>
                <li className="pl-1">Set summaries to help you learn more about each release</li>
              </ul>
            </div>
            <p>No spreadsheets. No ten open tabs. Just clear, fast insight.</p>
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <h2 className="text-[30px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[44px]">
            Why We Built It
          </h2>
          <div className="mt-4 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>We got tired of doing mental math at card shows.</p>
            <p>Averaging eBay sold listings. Guessing what felt fair. Trying to learn about a card while someone waited for an offer.</p>
            <p>The Pokemon market has grown a lot. But the tools haven&apos;t kept up.</p>
            <p>So we built the tool we wished we had.</p>
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <h2 className="text-[30px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[44px]">
            Our Mission
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            To make Pokemon card collecting easier, smarter, and more fun.
          </p>
          <p className="mt-4 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            Whether you&apos;re buying your first single or building a serious collection, PopAlpha helps you understand the market without the stress.
          </p>
        </section>
      </div>
    </main>
  );
}
