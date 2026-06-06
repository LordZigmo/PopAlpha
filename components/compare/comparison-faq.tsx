import type { FaqItem } from "@/lib/compare/types";

type ComparisonFaqProps = {
  items: FaqItem[];
};

// Visible Q&A. The same `items` feed the FAQPage JSON-LD, so structured data
// always matches the page.
export default function ComparisonFaq({ items }: ComparisonFaqProps) {
  return (
    <section className="mt-16">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-white sm:text-[28px]">
        ❓ FAQ
      </h2>
      <dl className="mt-6 divide-y divide-white/[0.06]">
        {items.map((item) => (
          <div key={item.question} className="py-5 first:pt-0">
            <dt className="text-[18px] font-medium text-white">{item.question}</dt>
            <dd className="mt-2 text-[17px] leading-8 text-[#9A9A9A]">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
