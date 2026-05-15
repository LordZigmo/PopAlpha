import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support | PopAlpha",
  description:
    "Get help with PopAlpha account access, subscriptions, scanner issues, privacy requests, and collector support.",
  alternates: { canonical: "/support" },
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-[#1E1E1E] pt-7">
      <h2 className="text-[18px] font-semibold text-[#F0F0F0] sm:text-[20px]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SupportLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="text-[#00B4D8] underline underline-offset-2 transition hover:text-[#7BDFF2]"
    >
      {children}
    </a>
  );
}

export default function SupportPage() {
  return (
    <main className="min-h-screen bg-[#0A0A0A] px-4 py-12 text-[#F0F0F0] sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
            Help
          </p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px]">
            PopAlpha Support
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[#A0A0A0]">
            Need help with your account, scanner, collection, or subscription?
            Email us and include the email address on your PopAlpha account, the
            device you are using, and a short description of what happened.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <a
              href="mailto:contact@popalpha.app?subject=PopAlpha%20Support"
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#00B4D8] px-5 text-[14px] font-semibold text-[#061014] transition hover:bg-[#7BDFF2]"
            >
              Email Support
            </a>
            <a
              href="mailto:contact@popalpha.app?subject=PopAlpha%20Account%20or%20Privacy%20Request"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[#2A2A2A] px-5 text-[14px] font-semibold text-[#F0F0F0] transition hover:border-[#3A3A3A] hover:bg-[#161616]"
            >
              Account or Privacy Request
            </a>
          </div>

          <div className="mt-8 space-y-8 text-[15px] leading-7 text-[#A0A0A0]">
            <Section title="Contact">
              <p>
                Email{" "}
                <SupportLink href="mailto:contact@popalpha.app">
                  contact@popalpha.app
                </SupportLink>
                . We usually respond within one business day. For account
                access, billing, or privacy requests, write from the email
                address tied to your PopAlpha account when possible.
              </p>
            </Section>

            <Section title="Account access">
              <ul className="list-disc space-y-2 pl-5 marker:text-[#D0D0D0]">
                <li>
                  PopAlpha uses passwordless sign-in. Choose Continue with
                  Email, Apple, or Google from the sign-in screen.
                </li>
                <li>
                  If an email code does not arrive, check spam/junk, wait a
                  minute, then request a new code.
                </li>
                <li>
                  If you cannot access your email provider anymore, contact us
                  from the best alternate address and include your PopAlpha
                  handle if you know it.
                </li>
              </ul>
            </Section>

            <Section title="Subscriptions and billing">
              <p>
                PopAlpha Pro subscriptions are managed by Apple. To cancel,
                renew, or change plans, open iOS Settings, tap your Apple ID,
                then Subscriptions.
              </p>
              <p>
                If Pro does not unlock after purchase, open the PopAlpha paywall
                and tap Restore Purchases. If that does not work, email us with
                the approximate purchase time and product shown on your receipt.
              </p>
            </Section>

            <Section title="Scanner help">
              <ul className="list-disc space-y-2 pl-5 marker:text-[#D0D0D0]">
                <li>
                  Grant camera access when prompted. If you denied it, open iOS
                  Settings, find PopAlpha, and enable Camera.
                </li>
                <li>
                  Scan one card at a time with the full card visible, good
                  lighting, and minimal glare.
                </li>
                <li>
                  If the scanner identifies the wrong card, use the correction
                  flow in the app when available or send us the card name, set,
                  and a short description of the mismatch.
                </li>
              </ul>
            </Section>

            <Section title="Collection data">
              <p>
                You can export your account data from Settings, Data &amp;
                Privacy, Export My Data. You can delete your account from
                Settings, Data &amp; Privacy, Delete My Account.
              </p>
              <p>
                Account deletion removes your PopAlpha account data from our
                systems. If you need help with a deletion or export request,
                email{" "}
                <SupportLink href="mailto:contact@popalpha.app?subject=PopAlpha%20Data%20Request">
                  contact@popalpha.app
                </SupportLink>
                .
              </p>
            </Section>

            <Section title="Reports and safety">
              <p>
                To report content or a profile, use the in-app report option
                when it is available. You can also email us with links,
                screenshots, usernames, and a short explanation.
              </p>
              <p>
                For community standards, read the{" "}
                <SupportLink href="/community-guidelines">
                  Community Guidelines
                </SupportLink>
                .
              </p>
            </Section>

            <Section title="Legal and privacy">
              <p>
                Read the{" "}
                <SupportLink href="/privacy">Privacy Policy</SupportLink> and{" "}
                <SupportLink href="/terms">Terms of Service</SupportLink>. For
                takedown notices, privacy questions, or legal requests, email{" "}
                <SupportLink href="mailto:contact@popalpha.app?subject=PopAlpha%20Legal%20Request">
                  contact@popalpha.app
                </SupportLink>
                .
              </p>
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}
