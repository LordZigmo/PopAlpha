import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import SiteHeader from "@/components/site-header";
import WaitlistForm from "@/components/landing/waitlist-form";
import IphoneMockup from "@/components/landing/iphone-mockup";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";

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
    <div className="landing-shell min-h-screen bg-[#060608] text-[#F0F0F0]">
      <SiteHeader
        navItems={[]}
        primaryCta={{ label: "Join Waitlist", href: "#waitlist" }}
        showSignIn={false}
        logoPriority
      />

      <Hero />
      <AIMarquee />
      <FeatureGrid />
      <HowItWorks />
      <FinalCta />
      <LandingFooter />
    </div>
  );
}

/* ── Hero ──────────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-16">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-[8%] h-[520px] w-[520px] rounded-full bg-[#00B4D8]/[0.10] blur-[140px]" />
        <div className="absolute right-[6%] top-20 h-[420px] w-[420px] rounded-full bg-[#7C3AED]/[0.08] blur-[160px]" />
      </div>

      <div className="relative mx-auto max-w-[1400px] px-5 pb-20 pt-16 sm:px-8 sm:pt-24 lg:pb-28 lg:pt-28">
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,360px)] lg:gap-16 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,420px)]">
          <div className="relative z-10 max-w-[720px]">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-[#9EB2C2]">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00B4D8] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00B4D8]" />
              </span>
              <span>Coming soon to iPhone</span>
            </div>

            <h1 className="mt-7 text-[clamp(3rem,5.5vw,4.75rem)] font-semibold leading-[0.95] tracking-[-0.045em] text-white">
              Pokémon card intelligence,
              <span className="mt-1 block bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent">
                tuned to you.
              </span>
            </h1>

            <p className="mt-6 max-w-[580px] text-[18px] leading-[1.55] text-[#B5BEC9]">
              PopAlpha is your AI scout for the Pokémon market. It learns the cards you care about,
              identifies any new card in a second, and tells you the moment to buy — all from your
              iPhone.
            </p>

            <div id="waitlist" className="mt-9 scroll-mt-24">
              <WaitlistForm variant="hero" />
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px] text-[#7B8794]">
              <HeroProof label="Personalized for you" />
              <HeroProof label="Buy-zone alerts" />
              <HeroProof label="Real-time scanner" />
              <HeroProof label="Daily AI brief" />
            </div>
          </div>

          <div className="relative hidden lg:flex lg:items-center lg:justify-center">
            <IphoneMockup size="hero" />
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroProof({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <svg className="h-4 w-4 text-[#00DC5A]" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.414L8.5 12.086l6.793-6.793a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
      <span>{label}</span>
    </div>
  );
}

/* ── AI Marquee ────────────────────────────────────────────────────────────── */

function AIMarquee() {
  return (
    <section className="relative overflow-hidden border-y border-white/[0.05] bg-[linear-gradient(180deg,#06070B_0%,#0A0D14_50%,#06070B_100%)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[#00B4D8]/[0.10] blur-[150px]" />
        <div className="absolute right-[12%] bottom-0 h-[320px] w-[420px] rounded-full bg-[#7C3AED]/[0.10] blur-[150px]" />
      </div>

      <div className="relative mx-auto max-w-[1200px] px-5 py-24 text-center sm:px-8 lg:py-36">
        <p className="text-[13px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">Built around you</p>
        <h2 className="mx-auto mt-5 max-w-[1200px] text-[clamp(3.5rem,8vw,7rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-white">
          An AI that knows your collection —
          <span className="block bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent">
            and tells you when to act.
          </span>
        </h2>
        <p className="mx-auto mt-8 max-w-[760px] text-[clamp(17px,1.5vw,21px)] leading-[1.55] text-[#B5BEC9]">
          PopAlpha tracks what you own, what you watch, and how you move — then pinpoints the
          cards worth buying and the exact moments they&rsquo;re undervalued.
        </p>

        <ul className="mx-auto mt-16 grid max-w-[1000px] gap-8 text-left md:grid-cols-3 md:gap-6">
          <MarqueeBullet
            title="A signal feed that filters the noise"
            detail="Movers, breakouts, and unusual activity — ranked by relevance to your collection, not the market."
          />
          <MarqueeBullet
            title="Your daily edge"
            detail="A personalized AI brief on what&rsquo;s moving in your niche — backed by live pricing, not hype."
          />
          <MarqueeBullet
            title="Buy when it actually matters"
            detail="Get alerted the moment a card drops into a historically strong buy zone — before everyone else catches on."
          />
        </ul>
      </div>
    </section>
  );
}

function MarqueeBullet({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="flex gap-4">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#00B4D8]/30 bg-[#00B4D8]/10">
        <span className="h-2 w-2 rounded-full bg-[#00B4D8]" />
      </div>
      <div>
        <p className="text-[15px] font-semibold tracking-tight text-white">{title}</p>
        <p className="mt-1 text-[14px] leading-[1.55] text-[#9FA4AE]">{detail}</p>
      </div>
    </li>
  );
}

/* ── Feature Grid ──────────────────────────────────────────────────────────── */

function FeatureGrid() {
  const features = [
    {
      eyebrow: "Real-time scanner",
      title: "Snap any card. Get the price.",
      detail:
        "Apple Vision\u2013powered camera ID \u2014 set, number, and variant in under a second. EN and JP prints, both native. The fastest way to price a card.",
      Icon: ScannerIcon,
    },
    {
      eyebrow: "Buy-zone intelligence",
      title: "Buy at the right moment.",
      detail:
        "PopAlpha tracks where prices have historically lived for the cards you watch. When one dips into its buy zone, a push fires the moment it happens.",
      Icon: TrendIcon,
    },
    {
      eyebrow: "Portfolio that thinks",
      title: "The more you track, the smarter it gets.",
      detail:
        "Graded and raw, lot-level cost basis, live valuation. Every card you scan or watchlist teaches the AI more about what you actually care about.",
      Icon: PortfolioIcon,
    },
  ];

  return (
    <section className="mx-auto max-w-[1400px] px-5 py-20 sm:px-8 lg:py-28">
      <div className="max-w-[680px]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">Built for iPhone</p>
        <h2 className="mt-3 text-[clamp(2rem,3.4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-white">
          Quick prices. Smart timing. A portfolio that learns.
        </h2>
      </div>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.eyebrow}
            className="group relative overflow-hidden rounded-[1.6rem] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(20,28,38,0.6),rgba(9,12,18,0.85))] p-6 transition hover:border-white/[0.12]"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[#00B4D8]/25 bg-[#00B4D8]/[0.08] text-[#7DD3FC]">
              <feature.Icon />
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">{feature.eyebrow}</p>
            <h3 className="mt-2 text-[22px] font-semibold tracking-[-0.025em] text-white">{feature.title}</h3>
            <p className="mt-3 text-[14px] leading-[1.6] text-[#9FA4AE]">{feature.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── How It Works ──────────────────────────────────────────────────────────── */

function HowItWorks() {
  const steps = [
    {
      step: "01",
      title: "Add the cards you care about",
      detail:
        "Snap to identify, then drop into your portfolio or watchlist with a tap. Every card you save becomes signal.",
    },
    {
      step: "02",
      title: "PopAlpha learns you",
      detail:
        "The AI studies what you own, watch, and search — building a picture of which sets, eras, and prints actually matter to you.",
    },
    {
      step: "03",
      title: "Get the right alert at the right moment",
      detail:
        "When a card you care about hits its buy zone, breaks out, or moves unusually, your iPhone pings you in real time.",
    },
  ];

  return (
    <section className="relative overflow-hidden border-t border-white/[0.05] bg-[#06070B]">
      <div className="mx-auto max-w-[1400px] px-5 py-20 sm:px-8 lg:py-28">
        <div className="max-w-[680px]">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">How it works</p>
          <h2 className="mt-3 text-[clamp(2rem,3.4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-white">
            Save what matters. Let the AI do the watching.
          </h2>
        </div>

        <ol className="mt-12 grid gap-5 md:grid-cols-3">
          {steps.map((step, index) => (
            <li
              key={step.step}
              className="relative rounded-[1.6rem] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(15,21,30,0.7),rgba(8,11,17,0.9))] p-6"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">Step</span>
                <span className="text-[40px] font-semibold leading-none tracking-[-0.04em] text-white/[0.12]">
                  {step.step}
                </span>
              </div>
              <h3 className="mt-3 text-[20px] font-semibold tracking-[-0.02em] text-white">{step.title}</h3>
              <p className="mt-2 text-[14px] leading-[1.6] text-[#9FA4AE]">{step.detail}</p>
              {index < steps.length - 1 ? (
                <div className="pointer-events-none absolute -right-3 top-1/2 hidden h-px w-6 -translate-y-1/2 bg-gradient-to-r from-white/[0.12] to-transparent md:block" />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ── Final CTA ─────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-white/[0.05] bg-[linear-gradient(180deg,#070A12_0%,#06070B_100%)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[400px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#00B4D8]/[0.08] blur-[160px]" />
      </div>

      <div className="relative mx-auto max-w-[1100px] px-5 py-24 text-center sm:px-8 lg:py-32">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">Pre-launch</p>
        <h2 className="mt-3 text-[clamp(2.25rem,3.8vw,3.5rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-white">
          The smartest way to collect Pokémon —
          <span className="block bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent">
            built for iPhone first.
          </span>
        </h2>
        <p className="mx-auto mt-5 max-w-[620px] text-[17px] leading-[1.55] text-[#B5BEC9]">
          We&rsquo;re opening up early access in waves. Drop your email and we&rsquo;ll be in touch
          when your spot is ready.
        </p>

        <div className="mt-10">
          <WaitlistForm variant="final" />
        </div>
      </div>
    </section>
  );
}

/* ── Footer ────────────────────────────────────────────────────────────────── */

function LandingFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[#060608] py-10">
      <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-4 px-5 text-[13px] text-[#7B8794] sm:flex-row sm:px-8">
        <p>&copy; {new Date().getFullYear()} PopAlpha. All rights reserved.</p>
        <div className="flex items-center gap-5">
          <Link href="/about" className="transition hover:text-white">About</Link>
          <Link href="/data" className="transition hover:text-white">Data</Link>
          <Link href="/sign-in" className="transition hover:text-white">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}

/* ── Inline Icons ──────────────────────────────────────────────────────────── */

function ScannerIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <circle cx="12" cy="12.5" r="3.6" />
      <path d="M9 6l1.4-2h3.2L15 6" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l5-6 4 4 8-9" />
      <path d="M14 6h6v6" />
    </svg>
  );
}

function PortfolioIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18M9 6V4h6v2" />
    </svg>
  );
}
