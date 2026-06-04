import Link from "next/link";
import { unstable_cache } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import SiteHeader from "@/components/site-header";
import WaitlistForm from "@/components/landing/waitlist-form";
import IphoneMockup from "@/components/landing/iphone-mockup";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import { getJapaneseCatalogState, type JapaneseCatalogState } from "@/lib/data/tier-summary";

export const revalidate = 3600;

const getCachedJpCoverage = unstable_cache(
  () => getJapaneseCatalogState(),
  ["landing-jp-coverage"],
  { revalidate: 3600 }
);

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

  let jpCoverage: JapaneseCatalogState | null = null;
  try {
    jpCoverage = await getCachedJpCoverage();
  } catch {
    jpCoverage = null;
  }

  return (
    <div className="landing-shell min-h-screen bg-[#060608] text-[#F0F0F0]">
      <SiteHeader
        navItems={[{ label: "Compare", href: "/compare" }]}
        primaryCta={{ label: "Join Waitlist", href: "#waitlist" }}
        showSignIn={false}
        logoPriority
      />

      <Hero />
      <DifferentiatorAnchor />
      <DifferentiatorCards jpCoverage={jpCoverage} />
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
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,580px)]">
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
              AI market briefs, collector-grade insights, and JP-native pricing — in your pocket.
              PopAlpha learns the cards you care about and tells you the moment to buy.
            </p>

            <div id="waitlist" className="mt-9 scroll-mt-24">
              <WaitlistForm variant="hero" />
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px] text-[#7B8794]">
              <HeroProof label="AI market briefs" />
              <HeroProof label="Collector insights" />
              <HeroProof label="JP-native pricing" />
              <HeroProof label="Real-time scanner" />
            </div>
          </div>

          <div className="relative hidden lg:block">
            <PhoneStack />
          </div>
        </div>
      </div>
    </section>
  );
}

function PhoneStack() {
  return (
    <div className="relative mx-auto h-[640px] w-full max-w-[560px]">
      <div className="absolute left-[2%] top-[8%] -rotate-[10deg] opacity-90">
        <div className="scale-[0.72] origin-top">
          <IphoneMockup size="hero" screen="brief" />
        </div>
      </div>
      <div className="absolute right-[4%] top-[6%] rotate-[8deg] opacity-90">
        <div className="scale-[0.72] origin-top">
          <IphoneMockup size="hero" screen="jp-pricing" />
        </div>
      </div>
      <div className="absolute left-1/2 top-0 -translate-x-1/2 z-10">
        <IphoneMockup size="hero" screen="scanner" />
      </div>
    </div>
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

/* ── Differentiator Anchor ─────────────────────────────────────────────────── */

function DifferentiatorAnchor() {
  return (
    <section className="relative overflow-hidden border-y border-white/[0.05] bg-[linear-gradient(180deg,#06070B_0%,#0A0D14_50%,#06070B_100%)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[#00B4D8]/[0.10] blur-[150px]" />
        <div className="absolute right-[12%] bottom-0 h-[320px] w-[420px] rounded-full bg-[#7C3AED]/[0.10] blur-[150px]" />
      </div>

      <div className="relative mx-auto grid max-w-[1400px] gap-14 px-5 py-24 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-center lg:gap-16 lg:py-32">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#7DD3FC]">Beyond the scan</p>
          <h2 className="mt-5 text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[0.95] tracking-[-0.045em] text-white">
            Every scan comes with a brief,
            <span className="mt-1 block bg-gradient-to-r from-[#9BE7F6] via-[#36D6E7] to-[#00C7B7] bg-clip-text text-transparent">
              a buy signal, and JP-native prices.
            </span>
          </h2>
          <p className="mt-6 max-w-[600px] text-[17px] leading-[1.55] text-[#B5BEC9]">
            Most scanners stop at a price. PopAlpha tells you why it moved, whether to buy, and how
            it&rsquo;s trading in Japan — for every card, every day.
          </p>

          <ul className="mt-10 grid gap-6 sm:grid-cols-2">
            <AnchorBullet
              title="AI Market Briefs"
              detail="Why a card moved, in plain English — for every card you watch."
            />
            <AnchorBullet
              title="Collector Insights"
              detail="Personalized to your collection, not the broader market."
            />
            <AnchorBullet
              title="JP-Native Pricing"
              detail="Snkrdunk and Yahoo! Auctions JP — pulled direct, refreshed hourly."
            />
            <AnchorBullet
              title="EN + JP Scanning"
              detail="Apple Vision–powered camera ID, both languages native."
            />
          </ul>
        </div>

        <div className="relative hidden lg:block">
          <div className="relative mx-auto h-[640px] w-full max-w-[420px]">
            <div className="absolute left-[8%] top-[12%] -rotate-[8deg] opacity-90">
              <div className="scale-[0.7] origin-top">
                <IphoneMockup size="hero" screen="portfolio" />
              </div>
            </div>
            <div className="absolute right-[6%] top-0 rotate-[6deg]">
              <div className="scale-[0.78] origin-top">
                <IphoneMockup size="hero" screen="for-you" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AnchorBullet({ title, detail }: { title: string; detail: string }) {
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

/* ── Differentiator Cards ──────────────────────────────────────────────────── */

function DifferentiatorCards({ jpCoverage }: { jpCoverage: JapaneseCatalogState | null }) {
  return (
    <section className="mx-auto max-w-[1400px] px-5 py-20 sm:px-8 lg:py-28">
      <div className="max-w-[820px]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">
          Built for collectors who want the market edge
        </p>
        <h2 className="mt-3 text-[clamp(2rem,3.4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-white">
          Scan the card. Understand the market. Know what matters next.
        </h2>
        <p className="mt-5 max-w-[680px] text-[17px] leading-[1.55] text-[#B5BEC9]">
          PopAlpha combines fast card recognition with AI market analysis, collector
          personalization, and native Japanese pricing — so you&rsquo;re not just checking prices,
          you&rsquo;re building conviction.
        </p>
      </div>

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        <DifferentiatorCard
          tint="#0A2230"
          accentColor="#7DD3FC"
          label="AI Market Briefs"
          headline="A daily market read for every card you follow."
          body="See what moved, why it matters, and what to watch next — written in plain English and grounded in live pricing."
          screen="brief"
        />
        <DifferentiatorCard
          tint="#221638"
          accentColor="#C4B5FD"
          label="Collector Insights"
          headline="Signals built around your taste."
          body="PopAlpha learns from the cards you scan, watch, and own. Over time, it understands your collector style and surfaces the market moves most relevant to you."
          screen="for-you"
        />
        <DifferentiatorCard
          tint="#2B0F1E"
          accentColor="#F9A8D4"
          label="JP-Native Pricing"
          headline="Real JP market context."
          body="Track Japanese cards using native Japanese marketplace data, with transparency around set coverage and freshness — not just translated listings or English-market proxies."
          screen="jp-pricing"
          footer={<JpCoverageStrip jpCoverage={jpCoverage} />}
        />
      </div>
    </section>
  );
}

function DifferentiatorCard({
  tint,
  accentColor,
  label,
  headline,
  body,
  screen,
  footer,
}: {
  tint: string;
  accentColor: string;
  label: string;
  headline: string;
  body: string;
  screen: "brief" | "for-you" | "jp-pricing";
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-[1.6rem] border border-white/[0.06] p-6 transition hover:border-white/[0.12]"
      style={{
        background: `linear-gradient(180deg, ${tint} 0%, rgba(6,7,11,0.95) 100%)`,
      }}
    >
      <p
        className="text-[11px] font-semibold uppercase tracking-[0.22em]"
        style={{ color: accentColor }}
      >
        {label}
      </p>
      <h3 className="mt-3 text-[22px] font-semibold leading-[1.15] tracking-[-0.025em] text-white">
        {headline}
      </h3>
      <p className="mt-3 text-[14px] leading-[1.6] text-[#9FA4AE]">{body}</p>

      <div className="relative mt-8 flex h-[400px] items-end justify-center overflow-hidden">
        <div className="absolute bottom-[-60px] left-1/2 -translate-x-1/2">
          <div className="scale-[0.78] origin-bottom">
            <IphoneMockup size="hero" screen={screen} />
          </div>
        </div>
      </div>

      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}

function JpCoverageStrip({ jpCoverage }: { jpCoverage: JapaneseCatalogState | null }) {
  if (!jpCoverage || jpCoverage.totalCards === 0) {
    return (
      <div className="rounded-[1rem] border border-white/[0.06] bg-black/40 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#F9A8D4]">
          Live coverage
        </p>
        <p className="mt-1.5 text-[13px] text-[#B5BEC9]">
          Direct integrations with Snkrdunk and Yahoo! Auctions JP, refreshed hourly.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-[#9FA4AE]">
          <span>Snkrdunk</span>
          <span className="text-[#3D2235]">·</span>
          <span>Yahoo! Auctions JP</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[1rem] border border-white/[0.06] bg-black/40 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#F9A8D4]">
        Live coverage
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <JpStat value={jpCoverage.totalCards.toLocaleString()} label="JP cards" />
        <JpStat value={jpCoverage.totalSets.toString()} label="sets" />
        <JpStat value={`${jpCoverage.freshPct.toFixed(1)}%`} label="fresh · 7d" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-[#9FA4AE]">
        <span>Snkrdunk</span>
        <span className="text-[#3D2235]">·</span>
        <span>Yahoo! Auctions JP</span>
      </div>
    </div>
  );
}

function JpStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-[18px] font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#9FA4AE]">
        {label}
      </p>
    </div>
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

        <p className="mt-8 text-[13px] text-[#7B8794]">
          <Link
            href="/compare"
            className="inline-flex items-center gap-1 text-[#9EB2C2] transition hover:text-white"
          >
            Compare PopAlpha to other apps
            <span aria-hidden="true">→</span>
          </Link>
        </p>
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
          <Link href="/compare" className="transition hover:text-white">Compare</Link>
          <Link href="/data" className="transition hover:text-white">Data</Link>
          <Link href="/sign-in" className="transition hover:text-white">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
