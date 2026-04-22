import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | PopAlpha",
  description:
    "How PopAlpha collects, uses, and protects your data. Last updated April 2026.",
  alternates: { canonical: "/privacy" },
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
export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Legal
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
            Privacy Policy
          </h1>
          <p className="mt-2 text-[13px] text-[#6B6B6B]">
            Last updated April 6, 2026
          </p>

          <div className="mt-8 space-y-8 text-[15px] leading-7 text-[#A0A0A0]">
            {/* ---------------------------------------------------- */}
            <p>
              PopAlpha (&quot;we,&quot; &quot;us,&quot; &quot;our&quot;) operates
              the PopAlpha website and iOS app. This policy explains what
              information we collect, why we collect it, and what choices you
              have.
            </p>

            {/* ---------------------------------------------------- */}
            <Section title="1. Information we collect">
              <p className="font-medium text-[#D0D0D0]">
                Account information
              </p>
              <p>
                When you create an account through our authentication provider
                (Clerk), we receive your email address and, if you provide them,
                your name and profile picture. You also choose a public handle
                and may add a short bio and banner image.
              </p>

              <p className="font-medium text-[#D0D0D0]">Collection data</p>
              <p>
                If you track cards in your portfolio, we store the card
                identifier, grade, quantity, price paid, acquisition date,
                purchase venue, and certification number you enter. We also
                store your wishlist selections and any notes you attach.
              </p>

              <p className="font-medium text-[#D0D0D0]">Social activity</p>
              <p>
                When you post updates, like or comment on activity, or follow
                other collectors, we store those interactions so they appear in
                feeds and notifications.
              </p>

              <p className="font-medium text-[#D0D0D0]">Device information</p>
              <p>
                We collect basic analytics through Vercel Web Analytics and
                Speed Insights, which record page views, performance metrics,
                and broad device categories. We also use PostHog for product
                analytics — tracking which features you use, funnel completion,
                and aggregated engagement so we can improve the product. PostHog
                is configured to capture exceptions for error monitoring and may
                record session replays of anonymized interactions (no password,
                email, or payment fields are captured). We do not use cookies
                for tracking or advertising. The only cookies on our site are
                strictly necessary authentication cookies set by Clerk and a
                first-party PostHog session cookie.
              </p>

              <p className="font-medium text-[#D0D0D0]">
                Push notification tokens
              </p>
              <p>
                If you opt in to push notifications, we store the subscription
                endpoint, cryptographic keys, and platform name needed to
                deliver messages.
              </p>

              <p className="font-medium text-[#D0D0D0]">Camera (iOS app)</p>
              <p>
                The card scanner uses your device camera to identify cards. Images are
                processed on your device and are not uploaded to our servers
                unless you explicitly confirm.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="2. How we use your information">
              <ul className="list-disc space-y-2 pl-5 marker:text-[#D0D0D0]">
                <li>
                  Provide the service: display your portfolio, deliver your
                  activity feed, send notifications you opted into.
                </li>
                <li>
                  Generate card intelligence: card summaries and market analysis
                  are produced by sending card metadata (name, set, price) to
                  Google Gemini. No personal data is included in those requests.
                </li>
                <li>
                  Improve the product: we use Vercel Analytics and PostHog to
                  understand which pages are visited, how features are used,
                  where users drop off in funnels, and how the site performs.
                </li>
                <li>
                  Communicate with you: service emails, optional weekly
                  digests, and product updates you can toggle off in Settings.
                </li>
              </ul>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="3. Who we share data with">
              <p>
                We do not sell your data. We do not share it with advertising
                networks or data brokers. The third-party services that process
                data on our behalf are:
              </p>
              <ul className="list-disc space-y-2 pl-5 marker:text-[#D0D0D0]">
                <li>
                  <span className="text-[#D0D0D0]">Clerk</span> &mdash;
                  authentication and session management.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">Supabase</span> &mdash;
                  database hosting with row-level security.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">Vercel</span> &mdash;
                  hosting, analytics, and performance monitoring.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">Google Gemini</span> &mdash;
                  card-level AI summaries (receives card metadata only, never
                  personal data).
                </li>
              </ul>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="4. Data retention">
              <p>
                We keep your data for as long as your account is active.
                Holdings, wishlist items, and activity remain until you delete
                them individually or delete your entire account.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="5. Your rights and choices">
              <ul className="list-disc space-y-2 pl-5 marker:text-[#D0D0D0]">
                <li>
                  <span className="text-[#D0D0D0]">Export your data.</span>{" "}
                  Settings &rarr; Data &amp; Privacy &rarr; Export My Data
                  downloads everything as JSON.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">Delete your account.</span>{" "}
                  Settings &rarr; Data &amp; Privacy &rarr; Delete My Account
                  permanently removes all your data from our systems.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">
                    Manage notifications.
                  </span>{" "}
                  Toggle price alerts, weekly digest, and product updates on or
                  off at any time in Settings.
                </li>
                <li>
                  <span className="text-[#D0D0D0]">Control visibility.</span>{" "}
                  Set your profile and activity to public, followers-only, or
                  private.
                </li>
              </ul>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="6. Children's privacy">
              <p>
                PopAlpha is not directed at children under 13. We do not
                knowingly collect personal information from children. If you
                believe a child has provided us with data, contact us and we
                will delete it.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="7. Security">
              <p>
                All data is transmitted over HTTPS. Database access is governed
                by row-level security policies that scope every query to the
                authenticated user. Authentication tokens are managed by Clerk
                and are never stored in plain text on our servers.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="8. Changes to this policy">
              <p>
                If we make material changes, we will update the date at the top
                of this page and, where practical, notify you in-app.
              </p>
            </Section>

            {/* ---------------------------------------------------- */}
            <Section title="9. Contact">
              <p>
                Questions or requests? Email us at{" "}
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
