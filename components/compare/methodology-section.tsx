// "Shows its work" — how PopAlpha derives the prices it shows, for trust / E-E-A-T.
// Shared across the comparison pages. EN price sources are described as "PopAlpha
// market feeds" (not named) per the no-direct-EN-sourcing rule in
// docs/release-handoff-2026-05-28.md; the JP marketplaces (Yahoo! Auctions Japan +
// Snkrdunk) are compliant to name and are cited as links. Prices are a conservative
// sold-based anchor, graded separately, with freshness labels.
export default function MethodologySection() {
  return (
    <section className="mt-16">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-white sm:text-[28px]">
        🧮 How PopAlpha prices cards
      </h2>
      <div className="mt-4 space-y-4 text-[18px] leading-8 text-[#A8A8A8]">
        <p>
          PopAlpha doesn&rsquo;t invent prices — it reads real sold data. English cards are priced
          from PopAlpha&rsquo;s own market feeds, built from real US sold-listing and marketplace
          data. Japanese cards are priced natively from{" "}
          <SourceLink href="https://auctions.yahoo.co.jp/">Yahoo! Auctions Japan</SourceLink> and{" "}
          <SourceLink href="https://snkrdunk.com/">Snkrdunk</SourceLink>, using whichever source has
          more recent sample sales.
        </p>
        <p>
          Rather than a single optimistic &ldquo;value&rdquo;, PopAlpha anchors on a conservative
          market price built from recent sold transactions, and treats raw and graded copies
          (PSA&nbsp;9, PSA&nbsp;10) as separate markets with their own prices.
        </p>
        <p>
          Every price is labelled with how fresh it is — from a live price (sold within the last
          week), to recently stale (one to four weeks), to older (one to six months). When there
          isn&rsquo;t enough recent sold data, PopAlpha shows &ldquo;no recent market&rdquo; instead
          of guessing.
        </p>
      </div>
    </section>
  );
}

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#E8E8E8] underline decoration-white/20 underline-offset-2 transition hover:decoration-white/60"
    >
      {children}
    </a>
  );
}
