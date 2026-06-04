import type { ListicleApp } from "@/lib/compare/types";

// Ranked "best of" list, hairline-separated to match the minimalist aesthetic
// (no boxes). PopAlpha gets a subtle "Our pick" badge.
export default function ListicleList({ apps }: { apps: ListicleApp[] }) {
  return (
    <ol className="mt-8 divide-y divide-white/[0.08]">
      {apps.map((app) => (
        <li key={app.rank} className="py-7 first:pt-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[18px] font-semibold text-[#8A8A8E]">{app.rank}.</span>
            <h3 className="text-[21px] font-semibold tracking-[-0.01em] text-white sm:text-[24px]">
              {app.name}
            </h3>
            {app.isPopAlpha ? (
              <span className="rounded-full bg-[#00B4D8]/15 px-2.5 py-0.5 text-[12px] font-semibold text-[#7DD3FC]">
                Our pick
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-[18px] leading-7 text-[#CFCFCF]">{app.oneLiner}</p>
          <p className="mt-3 text-[16px] font-medium text-[#9A9A9A]">{app.bestFor}</p>
          <ul className="mt-3 space-y-2 text-[17px] leading-7 text-[#A8A8A8]">
            {app.notes.map((note, index) => (
              <li key={index} className="flex gap-2.5">
                <span aria-hidden="true" className="select-none text-[#5A5A5A]">
                  –
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
