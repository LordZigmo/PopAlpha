import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About | PopAlpha",
  description: "What PopAlpha tracks, how the data works, and what the platform is building.",
  alternates: {
    canonical: "/about",
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
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            PopAlpha is a simple tool that helps you understand Pokemon card prices fast.
          </h1>
          <div className="mt-6 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>
              If youve ever stood at a card show with your phone out, flipping between eBay listings and price charts, you know the feeling.
            </p>
            <div>
              <p>Youre trying to figure out:</p>
              <p className="mt-3">Is this a fair price?</p>
              <p>Is this card trending up?</p>
              <p>Why is this version more expensive?</p>
              <p>Am I about to overpay?</p>
            </div>
            <p>Weve felt that pain too.</p>
            <p>
              Sometimes you dont just want a list of past sales. You want the vibe of the card. Is it hot? Quiet? Undervalued? Overhyped?
            </p>
            <p>PopAlpha was built to give you that answer in seconds.</p>
          </div>
        </div>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Built For Singles Collectors
          </p>
          <div className="mt-4 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>Right now, we focus on raw Pokemon card singles.</p>
            <p>
              Each version of a card Holo, Non-Holo, 1st Edition, Shadowless acts differently in the market. So we treat them differently.
            </p>
            <div>
              <p>PopAlpha tracks:</p>
              <p className="mt-3">Real Pokemon card sale prices</p>
              <p>Variant-specific price changes</p>
              <p>Market trends</p>
              <p>A Market Balance Price (our estimate of whats fair right now)</p>
              <p>Set summaries to help you learn more about each release</p>
            </div>
            <p>No spreadsheets. No ten open tabs. Just clear, fast insight.</p>
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Why We Built It
          </p>
          <div className="mt-4 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            <p>We got tired of doing mental math at card shows.</p>
            <p>Averaging eBay sold listings. Guessing what felt fair. Trying to learn about a card while someone waited for an offer.</p>
            <p>The Pokemon market has grown a lot. But the tools havent kept up.</p>
            <p>So we built the tool we wished we had.</p>
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Our Mission
          </p>
          <p className="mt-4 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            To make Pokemon card collecting easier, smarter, and more fun.
          </p>
          <p className="mt-4 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            Whether youre buying your first single or building a serious collection, PopAlpha helps you understand the market without the stress.
          </p>
        </section>
      </div>
    </main>
  );
}
