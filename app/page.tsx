import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import SiteHeader from "@/components/site-header";
import AppStoreBadge from "@/components/landing/app-store-badge";
import PhoneFrame from "@/components/landing/phone-frame";
import Reveal from "@/components/landing/reveal";
import LandingHero from "@/components/landing/landing-hero";
import { appStoreHref } from "@/lib/marketing/app-store";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import JsonLd from "@/components/compare/json-ld";
import { organizationSchema, webSiteSchema } from "@/lib/seo/schema";

export const revalidate = 3600;

export default async function Home() {
  if (clerkEnabled) {
    let userId: string | null = null;
    try {
      const session = await auth();
      userId = session.userId ?? null;
    } catch {
      userId = null;
    }
    if (userId) redirect("/portfolio");
  }

  return (
    <div className="landing-shell min-h-screen bg-[#05060A] text-[#F0F0F0]">
      <SiteHeader
        navItems={[{ label: "Compare", href: "/compare" }]}
        primaryCta={{ label: "Get the app", href: appStoreHref }}
        showSignIn={false}
        logoPriority
      />
      <JsonLd data={[organizationSchema(), webSiteSchema()]} />

      <LandingHero />
      <HowItWorks />
      <MarketBriefs />
      <WhyPopAlpha />
      <FinalCta />
      <LandingFooter />
    </div>
  );
}

/* ── How it works: the three screens, in order ──────────────────────────────── */

const STEPS = [
  {
    n: "1",
    title: "Scan your card",
    body: "Hold your phone over any Pokémon card. PopAlpha knows which card it is right away — no typing, no searching.",
    src: "/screenshots/scan-ar.jpg",
    alt: "PopAlpha scanning a Paldean Wooper card with its $3.11 price shown",
    accent: "#22D3EE",
  },
  {
    n: "2",
    title: "See what it's worth",
    body: "Get the price in seconds. PopAlpha also tells you, in plain words, if the card is going up or down.",
    src: "/screenshots/wooper-detail.jpg",
    alt: "PopAlpha card page for Paldean Wooper showing its price and a short summary",
    accent: "#2DD4BF",
  },
  {
    n: "3",
    title: "Track your collection",
    body: "Save your cards in one place and watch what they're worth over time. See your whole collection at a glance.",
    src: "/screenshots/portfolio-light.jpg",
    alt: "PopAlpha collection page showing a total value of $276 and how it has grown",
    accent: "#34D399",
  },
];

function HowItWorks() {
  return (
    <section className="relative overflow-hidden border-t border-white/[0.05] bg-[#05060A]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-8%] h-[420px] w-[920px] -translate-x-1/2 rounded-full bg-[#22D3EE]/[0.06] blur-[160px]" />
      </div>

      <div className="relative mx-auto max-w-[1180px] px-5 py-24 sm:px-8 lg:py-28">
        <Reveal className="mx-auto max-w-[680px] text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">
            How it works
          </p>
          <h2 className="mt-3 text-[clamp(2rem,3.6vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-white">
            Three taps from card to price.
          </h2>
          <p className="mx-auto mt-5 max-w-[540px] text-[17px] leading-[1.6] text-[#B5BEC9]">
            No spreadsheets. No guessing. Point your phone and PopAlpha does the rest.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-8 lg:mt-20 lg:grid-cols-3 lg:gap-6">
          {STEPS.map((step, index) => (
            <Reveal key={step.n} delay={index * 0.12}>
              <StepCard step={step} last={index === STEPS.length - 1} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step, last }: { step: (typeof STEPS)[number]; last: boolean }) {
  return (
    <div className="group relative flex h-full flex-col items-center rounded-[1.8rem] border border-white/[0.07] bg-white/[0.02] px-6 pb-8 pt-12 text-center backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:border-white/[0.15] hover:bg-white/[0.04]">
      {/* number badge sitting on the top edge */}
      <span
        className="absolute left-1/2 top-0 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[15px] font-semibold text-white"
        style={{
          borderColor: `${step.accent}66`,
          background: `linear-gradient(180deg, ${step.accent}33, #0A0D12)`,
          boxShadow: `0 0 24px -6px ${step.accent}`,
        }}
      >
        {step.n}
      </span>

      {/* phone */}
      <div className="relative w-[200px] lg:w-[185px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-8 rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle at 50% 35%, ${step.accent}33, transparent 68%)` }}
        />
        <PhoneFrame src={step.src} alt={step.alt} className="w-full" sizes="(max-width: 1024px) 55vw, 200px" />
      </div>

      <h3 className="mt-7 text-[20px] font-semibold tracking-[-0.02em] text-white">{step.title}</h3>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-[#9FA4AE]">{step.body}</p>

      {/* left-to-right flow arrow between steps (desktop) */}
      {!last ? (
        <span
          aria-hidden="true"
          className="absolute right-[-15px] top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-[#0A0D12] text-[#7DD3FC] shadow-[0_4px_16px_rgba(0,0,0,0.5)] lg:flex"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      ) : null}
    </div>
  );
}

/* ── Market Briefs spotlight ─────────────────────────────────────────────────── */

function MarketBriefs() {
  return (
    <section className="relative overflow-hidden border-t border-white/[0.05] bg-[linear-gradient(180deg,#070A12_0%,#05060A_100%)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute right-[6%] top-[8%] h-[440px] w-[540px] rounded-full bg-[#FB923C]/[0.06] blur-[160px]" />
        <div className="absolute bottom-0 left-[6%] h-[360px] w-[480px] rounded-full bg-[#22D3EE]/[0.07] blur-[160px]" />
      </div>

      <div className="relative mx-auto grid max-w-[1180px] items-center gap-14 px-5 py-24 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:py-28">
        {/* copy */}
        <Reveal>
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">
            PopAlpha Market Briefs
          </p>
          <h2 className="mt-3 text-[clamp(2rem,3.6vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-white">
            A market brief for every single card.
          </h2>
          <p className="mt-5 max-w-[520px] text-[17px] leading-[1.6] text-[#B5BEC9]">
            PopAlpha reads the market and writes a short, plain-English brief for every card — so
            you instantly know if it&rsquo;s heating up, cooling off, or just holding steady. No
            charts to read. No homework.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignalChip label="Breakout" color="#FB923C" dir="up" />
            <SignalChip label="Cooling off" color="#38BDF8" dir="down" />
            <SignalChip label="Steady" color="#34D399" dir="flat" />
          </div>
        </Reveal>

        {/* visual: card page + a readable brief */}
        <Reveal delay={0.12}>
          <div className="relative mx-auto w-[256px] sm:w-[288px]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-10 rounded-full blur-3xl"
              style={{ background: "radial-gradient(circle at 50% 35%, rgba(251,146,60,0.20), transparent 68%)" }}
            />
            <PhoneFrame
              src="/screenshots/card-detail.jpg"
              alt="PopAlpha card page for Zorua with an AI market brief explaining a breakout"
              className="w-full"
              sizes="(max-width: 1024px) 70vw, 288px"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function SignalChip({ label, color, dir }: { label: string; color: string; dir: "up" | "down" | "flat" }) {
  const path = dir === "up" ? "M3 16l5-5 4 4 8-8" : dir === "down" ? "M3 8l5 5 4-4 8 8" : "M4 12h16";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold backdrop-blur-xl"
      style={{ borderColor: `${color}44`, backgroundColor: `${color}14`, color }}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
      {label}
    </span>
  );
}

/* ── Why PopAlpha: plain reasons ─────────────────────────────────────────────── */

const FEATURES = [
  {
    title: "Free to scan",
    body: "Scan as many cards as you want. No limit, no cost.",
    icon: (
      <path d="M5 13l4 4L19 7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "English & Japanese",
    body: "Works with English and Japanese cards.",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" strokeWidth="1.8" />
        <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" strokeWidth="1.4" />
      </>
    ),
  },
  {
    title: "Real prices",
    body: "Prices come from real sales and update every day.",
    icon: (
      <path
        d="M4 18l5-5 3 3 7-8M16 8h4v4"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    title: "Easy to use",
    body: "No clutter. Just point your phone and go.",
    icon: (
      <>
        <rect x="7" y="3" width="10" height="18" rx="2.5" strokeWidth="1.8" />
        <path d="M11 18h2" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
];

function WhyPopAlpha() {
  return (
    <section className="relative overflow-hidden border-t border-white/[0.05] bg-[#05060A]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-[360px] w-[760px] -translate-x-1/2 rounded-full bg-[#2DD4BF]/[0.07] blur-[160px]" />
      </div>
      <div className="relative mx-auto max-w-[1180px] px-5 py-24 sm:px-8 lg:py-28">
        <Reveal className="mx-auto max-w-[640px] text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">
            Why PopAlpha
          </p>
          <h2 className="mt-3 text-[clamp(2rem,3.6vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-white">
            Made simple, on purpose.
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature, index) => (
            <Reveal key={feature.title} delay={index * 0.06}>
              <div className="h-full rounded-[1.5rem] border border-white/[0.08] bg-white/[0.03] p-6 backdrop-blur-xl transition hover:border-white/[0.16] hover:bg-white/[0.05]">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#22D3EE]/30 bg-[#22D3EE]/10 text-[#7DD3FC]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5">
                    {feature.icon}
                  </svg>
                </span>
                <h3 className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-white">
                  {feature.title}
                </h3>
                <p className="mt-2 text-[14px] leading-[1.6] text-[#9FA4AE]">{feature.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Final CTA ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section
      id="download"
      className="relative scroll-mt-24 overflow-hidden border-t border-white/[0.05] bg-[linear-gradient(180deg,#070A12_0%,#05060A_100%)]"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[400px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#22D3EE]/[0.10] blur-[160px]" />
      </div>

      <div className="relative mx-auto max-w-[820px] px-5 py-24 text-center sm:px-8 lg:py-32">
        <Reveal>
          <h2 className="text-[clamp(2.25rem,4vw,3.5rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-white">
            Know what your cards are worth.
          </h2>
          <p className="mx-auto mt-5 max-w-[520px] text-[17px] leading-[1.6] text-[#B5BEC9]">
            PopAlpha is free on iPhone. Download it on the App Store and start scanning in
            seconds.
          </p>

          <div className="mt-9 flex justify-center">
            <AppStoreBadge size="lg" data-cta="final" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Footer ─────────────────────────────────────────────────────────────────── */

function LandingFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[#05060A] py-10">
      <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-4 px-5 text-[13px] text-[#7B8794] sm:flex-row sm:px-8">
        <p>&copy; {new Date().getFullYear()} PopAlpha. All rights reserved.</p>
        <div className="flex items-center gap-5">
          <Link href="/about" className="transition hover:text-white">
            About
          </Link>
          <Link href="/compare" className="transition hover:text-white">
            Compare
          </Link>
          <Link href="/sign-in" className="transition hover:text-white">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
