import AppStoreBadge from "@/components/landing/app-store-badge";
import type { CtaCopy } from "@/lib/compare/types";

type ComparisonCtaProps = {
  cta: CtaCopy;
};

// Download CTA, separated by a hairline rule. PopAlpha is live on the App Store,
// so this drives straight to the listing.
export default function ComparisonCta({ cta }: ComparisonCtaProps) {
  return (
    <section id="download" className="mt-20 border-t border-white/[0.08] pt-12">
      <h2 className="text-[26px] font-semibold tracking-[-0.01em] text-white sm:text-[30px]">
        {cta.heading}
      </h2>
      <p className="mt-3 max-w-[52ch] text-[18px] leading-8 text-[#A8A8A8]">{cta.body}</p>
      <div className="mt-6">
        <AppStoreBadge size="md" />
      </div>
    </section>
  );
}
