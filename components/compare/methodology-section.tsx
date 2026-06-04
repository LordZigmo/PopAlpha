// "Shows its work" — how PopAlpha derives the prices it shows, for trust / E-E-A-T.
// Shared across the comparison pages. Content is grounded in the real pricing
// pipeline: EN from Scrydex (primary) + PriceCharting + eBay sold listings; JP from
// Yahoo! Auctions Japan + Snkrdunk (source with more recent sample sales); a
// conservative sold-based market price, graded separately, with freshness labels.
export default function MethodologySection() {
  return (
    <section className="mt-16">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-white sm:text-[28px]">
        🧮 How PopAlpha prices cards
      </h2>
      <div className="mt-4 space-y-4 text-[18px] leading-8 text-[#A8A8A8]">
        <p>
          PopAlpha doesn&rsquo;t invent prices — it reads real sold data. English cards are priced from{" "}
          <span className="text-[#E8E8E8]">Scrydex</span>,{" "}
          <span className="text-[#E8E8E8]">PriceCharting</span>, and{" "}
          <span className="text-[#E8E8E8]">eBay</span> sold listings. Japanese cards are priced
          natively from <span className="text-[#E8E8E8]">Yahoo! Auctions Japan</span> and{" "}
          <span className="text-[#E8E8E8]">Snkrdunk</span>, using whichever source has more recent
          sample sales.
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
