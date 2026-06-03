import type { VersusRow } from "@/lib/compare/types";

type ComparisonTableProps = {
  caption: string;
  competitorName: string;
  rows: VersusRow[];
};

// A real, visible <table>. Every cell renders actual text — this is the source of
// truth that any structured data must mirror. The PopAlpha column is accent-tinted.
export default function ComparisonTable({
  caption,
  competitorName,
  rows,
}: ComparisonTableProps) {
  return (
    <section className="mt-6 rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
      <h2 className="text-[24px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[30px]">
        {caption}
      </h2>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left text-[14px] sm:text-[15px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[#1E1E1E]">
              <th scope="col" className="py-3 pr-4 font-semibold text-[#6B6B6B]">
                Feature
              </th>
              <th scope="col" className="py-3 pr-4 font-semibold text-[#00B4D8]">
                PopAlpha
              </th>
              <th scope="col" className="py-3 font-semibold text-[#A0A0A0]">
                {competitorName}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.feature} className="border-b border-[#1A1A1A] align-top">
                <th scope="row" className="py-3 pr-4 font-medium text-[#D0D0D0]">
                  {row.feature}
                </th>
                <td className="py-3 pr-4 text-[#E6E6E6]">{row.popalpha}</td>
                <td className="py-3 text-[#9A9A9A]">{row.competitor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
