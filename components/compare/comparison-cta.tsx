import WaitlistForm from "@/components/landing/waitlist-form";
import type { CtaCopy } from "@/lib/compare/types";

type ComparisonCtaProps = {
  cta: CtaCopy;
};

// Waitlist-only CTA, separated by a hairline rule. The embedded hero-variant
// WaitlistForm (a client component, fine as a leaf here) captures the email.
export default function ComparisonCta({ cta }: ComparisonCtaProps) {
  return (
    <section id="waitlist" className="mt-20 border-t border-white/[0.08] pt-12">
      <h2 className="text-[26px] font-semibold tracking-[-0.01em] text-white sm:text-[30px]">
        {cta.heading}
      </h2>
      <p className="mt-3 max-w-[52ch] text-[18px] leading-8 text-[#A8A8A8]">{cta.body}</p>
      <div className="mt-6">
        <WaitlistForm variant="hero" />
      </div>
    </section>
  );
}
