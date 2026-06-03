import WaitlistForm from "@/components/landing/waitlist-form";
import type { CtaCopy } from "@/lib/compare/types";

type ComparisonCtaProps = {
  cta: CtaCopy;
};

// Waitlist-only CTA. The headline/body provide context; the embedded hero-variant
// WaitlistForm (a client component, fine as a leaf inside this server component)
// captures the email and shows the "Coming soon to App Store" reassurance line.
export default function ComparisonCta({ cta }: ComparisonCtaProps) {
  return (
    <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
      <div className="mx-auto max-w-[46ch] text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00B4D8]">
          {cta.eyebrow}
        </p>
        <h2 className="mt-3 text-[26px] font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[34px]">
          {cta.heading}
        </h2>
        <p className="mt-3 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">{cta.body}</p>
      </div>
      <div className="mt-6 flex justify-center">
        <WaitlistForm variant="hero" />
      </div>
    </section>
  );
}
