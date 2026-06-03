import type { BreakdownSection } from "@/lib/compare/types";

type HonestBreakdownProps = {
  sections: BreakdownSection[];
};

export default function HonestBreakdown({ sections }: HonestBreakdownProps) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.heading} className="mt-16">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-white sm:text-[22px]">
            {section.heading}
          </h2>
          <div className="mt-4 space-y-4 text-[16px] leading-7 text-[#A8A8A8]">
            {section.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
