import type { VersusRow } from "@/lib/compare/types";

type ComparisonTableProps = {
  caption: string;
  competitorName: string;
  rows: VersusRow[];
};

// Minimalist table: row separators only, no card/box. Real visible text in every
// cell. PopAlpha column is lightly emphasized; the competitor column stays muted.
export default function ComparisonTable({
  caption,
  competitorName,
  rows,
}: ComparisonTableProps) {
  return (
    <section className="mt-16">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-white sm:text-[28px]">
        {caption}
      </h2>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-left text-[17px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-white/[0.12] text-[14px]">
              <th scope="col" className="py-3 pr-4 font-normal text-[#8A8A8E]">
                Feature
              </th>
              <th scope="col" className="py-3 pr-4 font-medium text-white">
                PopAlpha
              </th>
              <th scope="col" className="py-3 font-normal text-[#8A8A8E]">
                {competitorName}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.feature} className="border-b border-white/[0.06] align-top">
                <th scope="row" className="py-4 pr-4 font-normal text-[#9A9A9A]">
                  {row.feature}
                </th>
                <td className="py-4 pr-4 text-[#E8E8E8]">{row.popalpha}</td>
                <td className="py-4 text-[#8A8A8E]">{row.competitor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
