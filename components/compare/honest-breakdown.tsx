import type { BreakdownSection } from "@/lib/compare/types";

type HonestBreakdownProps = {
  sections: BreakdownSection[];
};

export default function HonestBreakdown({ sections }: HonestBreakdownProps) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.heading} className="mt-16">
          <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-white sm:text-[28px]">
            {section.heading}
          </h2>
          <div className="mt-4 space-y-4 text-[18px] leading-8 text-[#A8A8A8]">
            {section.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
