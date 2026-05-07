import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Community Guidelines | PopAlpha",
  description:
    "PopAlpha's community standards, content moderation policy, and how to report or block users.",
  alternates: { canonical: "/community-guidelines" },
};

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

export default function CommunityGuidelinesPage() {
  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Community
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
            Community Guidelines
          </h1>
          <p className="mt-2 text-[13px] text-[#6B6B6B]">
            Last updated May 6, 2026
          </p>

          <div className="mt-8 space-y-8 text-[15px] leading-7 text-[#A0A0A0]">
            <p>
              PopAlpha is a place for collectors to share their pickups, track
              the market, and connect with other collectors. These guidelines
              keep the community safe and useful. By posting on PopAlpha you
              agree to follow them; failure to do so may result in content
              removal or account suspension.
            </p>

            <Section title="What you can do">
              <ul className="list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li>Share cards you&apos;ve added to your collection or wishlist.</li>
                <li>Comment on other collectors&apos; activity in good faith.</li>
                <li>Mention specific cards, sets, and prices factually.</li>
                <li>Follow collectors whose activity you find interesting.</li>
              </ul>
            </Section>

            <Section title="What you can't do">
              <p>The following content is not allowed anywhere on PopAlpha:</p>
              <ul className="list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li>
                  <strong className="text-[#D0D0D0]">Harassment or bullying.</strong>{" "}
                  Targeting another user with insults, threats, or sustained
                  unwanted contact.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Hate speech.</strong> Content
                  that attacks people based on race, ethnicity, religion,
                  gender, sexual orientation, disability, or other protected
                  characteristics.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Sexual or adult content.</strong>{" "}
                  PopAlpha is a collector-focused service; adult content is
                  off-topic and not permitted.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Violent threats or content.</strong>{" "}
                  Promotion of violence against any individual or group.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Spam, scams, or off-platform sales links.</strong>{" "}
                  Comments that promote external marketplaces, link-shorteners,
                  or unsolicited offers.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Impersonation.</strong>{" "}
                  Pretending to be another person or organization.
                </li>
                <li>
                  <strong className="text-[#D0D0D0]">Illegal content.</strong>{" "}
                  Anything that violates applicable law.
                </li>
              </ul>
            </Section>

            <Section title="How we moderate">
              <p>
                PopAlpha uses a combination of automated content filtering and
                human review:
              </p>
              <ul className="list-disc space-y-1 pl-5 marker:text-[#D0D0D0]">
                <li>
                  Comments are screened at submission time against a server-side
                  filter that blocks known slurs, harassment patterns, and
                  off-platform promotional links.
                </li>
                <li>
                  Reports submitted via the in-app{" "}
                  <strong className="text-[#D0D0D0]">Report</strong> button are
                  reviewed by our team within 24 hours during business days.
                </li>
                <li>
                  Content found to violate these guidelines is removed; accounts
                  with repeated violations are suspended or permanently
                  banned.
                </li>
                <li>
                  Severe violations — credible threats, child safety risks,
                  doxxing — are escalated immediately and may be referred to
                  law enforcement.
                </li>
              </ul>
            </Section>

            <Section title="Reporting content">
              <p>
                If you see something that violates these guidelines, tap the{" "}
                <strong className="text-[#D0D0D0]">…</strong> menu on the
                comment, profile, or activity item and choose{" "}
                <strong className="text-[#D0D0D0]">Report</strong>. Pick the
                reason that best describes the issue and add details if useful.
                Reports are private — the reported user is not told who reported
                them.
              </p>
            </Section>

            <Section title="Blocking users">
              <p>
                Blocking a user immediately hides their activity, comments, and
                profile from your view, and prevents them from seeing yours or
                interacting with your activity. Blocking is also private — the
                blocked user is not notified.
              </p>
              <p>
                Tap the <strong className="text-[#D0D0D0]">…</strong> menu on
                any comment, activity item, or profile to block. You can review
                and unblock users in <strong className="text-[#D0D0D0]">Settings</strong>{" "}
                at any time.
              </p>
            </Section>

            <Section title="Appeals">
              <p>
                If your content was removed or your account was actioned and you
                believe this was a mistake, email{" "}
                <a
                  href="mailto:contact@popalpha.app"
                  className="text-[#00B4D8] underline underline-offset-2"
                >
                  contact@popalpha.app
                </a>
                {" "}with the relevant details. We review appeals within 7
                days.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                Questions or feedback about these guidelines? Email{" "}
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
