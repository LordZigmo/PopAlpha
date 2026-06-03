import type { BreakdownSection } from "@/lib/compare/types";

type HonestBreakdownProps = {
  sections: BreakdownSection[];
};

export default function HonestBreakdown({ sections }: HonestBreakdownProps) {
  return (
    <>
      {sections.map((section) => (
        <section
          key={section.heading}
          className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8"
        >
          <h2 className="text-[24px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[30px]">
            {section.heading}
          </h2>
          <div className="mt-4 space-y-5 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
            {section.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
