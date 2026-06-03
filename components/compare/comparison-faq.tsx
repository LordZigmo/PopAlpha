import type { FaqItem } from "@/lib/compare/types";

type ComparisonFaqProps = {
  items: FaqItem[];
};

// Renders the FAQ as visible text. The same `items` feed the FAQPage JSON-LD, so
// the structured data always matches what's on the page.
export default function ComparisonFaq({ items }: ComparisonFaqProps) {
  return (
    <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
      <h2 className="text-[24px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[30px]">
        Frequently asked questions
      </h2>
      <dl className="mt-5 space-y-6">
        {items.map((item) => (
          <div key={item.question}>
            <dt className="text-[16px] font-semibold text-[#F0F0F0]">{item.question}</dt>
            <dd className="mt-2 text-[15px] leading-7 text-[#A0A0A0] sm:text-[16px]">
              {item.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
