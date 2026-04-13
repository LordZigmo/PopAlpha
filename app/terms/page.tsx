import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | PopAlpha",
  description: "Terms governing use of PopAlpha. Last updated April 2026.",
  alternates: { canonical: "/terms" },
};

/* ------------------------------------------------------------------ */
/*  Section helper                                                     */
/* ------------------------------------------------------------------ */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-[18px] font-semibold text-[#F0F0F0] sm:text-[20px]">
        {title}
      </h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */
export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Legal
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
            Terms of Service
          </h1>
          <p className="mt-2 text-[13px] text-[#6B6B6B]">
            Last updated April 6, 2026
          </p>

          <div className="mt-8 space-y-8 text-[15px] leading-7 text-[#A0A0A0]">
            {/* ---------------------------------------------------- */}
            <p>
              These terms apply when you use PopAlpha&apos;s website or iOS app
              (the &quot;Service&quot;). By using the Service you agree to these
              terms. If you don&apos;t agree, please don&apos;t use PopAlpha.
            </p>

            {/* ---------------------------------------------------- */}
            <Section title="1. What PopAlpha does">
              <p>
                PopAlpha provides market data, price analytics, and portfolio
                tracking tools for collectible trading cards. We aggregate
                publicly available pricing information and present it alongside
                AI-generated summaries and community features.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="2. Accounts">
              <p>
                You can browse card prices and market data without an account.
                Creating an account lets you track a portfolio, build a
                wishlist, follow other collectors, and post activity updates.
              </p>
              <p>
                You are responsible for keeping your login credentials secure.
                One account per person. You must be at least 13 years old to
                create an account.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="3. Your content">
              <p>
                You own everything you post (bios, comments, activity updates).
                By posting, you grant PopAlpha a license to display that content
                within the Service. You can delete your content at any time, and
                we will remove it promptly.
              </p>
              <p>Don&apos;t post content that is:</p>
              <ul className="list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li>Illegal or promotes illegal activity.</li>
                <li>
                  Harassing, threatening, or hateful toward other users.
                </li>
                <li>Spam, scam, or misleading.</li>
                <li>
                  Someone else&apos;s intellectual property without permission.
                </li>
              </ul>
              <p>
                We may remove content that violates these rules and suspend
                accounts that repeatedly do so.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="4. Pricing data and financial disclaimer">
              <p className="rounded-xl border border-[#2A2A2A] bg-[#0A0A0A] p-4 text-[14px] leading-6 text-[#C0C0C0]">
                PopAlpha is an informational tool, not a financial advisor. Card
                prices displayed are aggregated estimates derived from public
                market data and may not reflect the exact price you&apos;ll pay
                or receive for any card. Confidence scores, AI summaries, and
                trend indicators are analytical aids, not guarantees. Always do
                your own research before buying or selling.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="5. Free and paid features">
              <p>
                PopAlpha offers core features for free. We may introduce premium
                tiers with additional capabilities in the future. If we do,
                we&apos;ll clearly label what&apos;s free and what requires
                payment. We will never retroactively paywall data you&apos;ve
                already entered.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="6. Acceptable use">
              <p>You agree not to:</p>
              <ul className="list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li>
                  Scrape, crawl, or bulk-download data from PopAlpha for
                  commercial use.
                </li>
                <li>
                  Interfere with the Service&apos;s infrastructure or other
                  users&apos; access.
                </li>
                <li>
                  Create accounts through automated means (bots).
                </li>
                <li>
                  Impersonate another person or misrepresent your identity.
                </li>
                <li>
                  Reverse-engineer, decompile, or attempt to extract our source
                  code.
                </li>
              </ul>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="7. Intellectual property">
              <p>
                PopAlpha&apos;s branding, design, and original content are owned
                by us. Card names, images, and trademarks belong to their
                respective owners (The Pokemon Company, etc.) and are used for
                informational purposes under fair use.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="8. Account deletion">
              <p>
                You can delete your account at any time from Settings &rarr;
                Data &amp; Privacy &rarr; Delete My Account. This permanently
                removes all your data from our systems. We may also terminate
                accounts that violate these terms.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="9. Service availability">
              <p>
                We aim to keep PopAlpha available around the clock, but we
                can&apos;t guarantee uninterrupted access. We may modify,
                suspend, or discontinue parts of the Service with reasonable
                notice when possible.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="10. Limitation of liability">
              <p>
                To the fullest extent permitted by law, PopAlpha is provided
                &quot;as is.&quot; We are not liable for decisions you make
                based on data shown in the Service, including card purchases,
                sales, or trades. Our total liability for any claim is limited
                to the amount you paid us in the 12 months before the claim
                (which may be zero if you use only free features).
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="11. Changes to these terms">
              <p>
                We may update these terms from time to time. Material changes
                will be announced in-app or by email at least 14 days before
                they take effect. Continued use after that date means you accept
                the updated terms.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="12. Governing law">
              <p>
                These terms are governed by the laws of the State of Delaware,
                United States, without regard to conflict-of-law rules.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="13. Contact">
              <p>
                Questions about these terms? Email{" "}
                <a
                  href="mailto:contact@popalpha.app"
                  className="text-[#00B4D8] underline underline-offset-2"
                >
                  contact@popalpha.app
                </a>
                .
              </p>
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}
