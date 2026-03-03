/**
 * Locked pro section placeholder with blurred cards and CTA.
 * Renders server-side — no client JS.
 */
export default function ProSectionLocked({
  title,
  icon,
  description,
}: {
  title: string;
  icon?: string;
  description: string;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-2 px-4 sm:px-6">
        {icon ? <span className="text-base">{icon}</span> : null}
        <h2 className="text-[15px] font-semibold uppercase tracking-[0.08em] text-[#6B6B6B]">
          {title}
        </h2>
        <span className="rounded-full border border-amber-400/20 bg-amber-400/[0.08] px-2 py-0.5 text-[11px] font-semibold text-amber-200">
          PRO
        </span>
      </div>

      <div className="relative mt-3 px-4 sm:px-6">
        {/* Blurred fake cards */}
        <div className="flex gap-3 select-none" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex w-[160px] shrink-0 flex-col rounded-2xl border border-white/[0.04] bg-[#111] p-3.5"
              style={{ filter: "blur(6px)" }}
            >
              <div className="h-3 w-20 rounded-full bg-white/[0.08]" />
              <div className="mt-2 h-2.5 w-14 rounded-full bg-white/[0.05]" />
              <div className="mt-auto pt-3">
                <div className="h-4 w-12 rounded-full bg-white/[0.08]" />
              </div>
            </div>
          ))}
        </div>

        {/* Overlay CTA */}
        <div className="absolute inset-0 flex items-center justify-center px-4 sm:px-6">
          <div className="rounded-2xl border border-white/[0.08] bg-[#0A0A0A]/90 px-6 py-4 text-center backdrop-blur-sm">
            <p className="text-[13px] font-semibold text-[#D0D0D0]">{description}</p>
            <p className="mt-1.5 text-[12px] text-[#555]">
              Coming soon with PopAlpha Pro
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
