/**
 * Locked pro section placeholder with blurred cards and CTA.
 * Renders server-side — no client JS.
 */
const OBFUSCATED_POOL = [
  { rarity: "Special Illustration Rare", set: "Prismatic Evolutions", price: "$184" },
  { rarity: "Gold Hyper Rare", set: "151", price: "$126" },
  { rarity: "Special Illustration Rare", set: "Evolving Skies", price: "$242" },
  { rarity: "Gold Hyper Rare", set: "Paldean Fates", price: "$98" },
  { rarity: "Special Illustration Rare", set: "Twilight Masquerade", price: "$156" },
  { rarity: "Gold Hyper Rare", set: "Surging Sparks", price: "$88" },
] as const;

function buildObfuscatedRows() {
  const offset = Math.floor(Math.random() * OBFUSCATED_POOL.length);
  return Array.from({ length: 5 }, (_, index) => {
    const item = OBFUSCATED_POOL[(offset + index) % OBFUSCATED_POOL.length];
    return {
      ...item,
      codename: `Classified #${String(index + 1).padStart(2, "0")}`,
      change: index % 2 === 0 ? `+${8 + index}.${index}%` : `-${3 + index}.${index}%`,
    };
  });
}

export default function ProSectionLocked({
  title,
  icon,
  description,
  buttonLabel = "GO PREMIUM",
}: {
  title: string;
  icon?: string;
  description: string;
  buttonLabel?: string;
}) {
  const rows = buildObfuscatedRows();

  return (
    <section className="mt-8 lg:mx-auto lg:max-w-5xl lg:px-6">
      <div className="flex items-baseline gap-2 px-4 sm:px-6 lg:px-0">
        {icon ? <span className="text-lg">{icon}</span> : null}
        <h2 className="text-[18px] font-semibold uppercase tracking-[0.06em] text-[#D4D4D8] sm:text-[20px]">
          {title}
        </h2>
        <span className="rounded-full border border-amber-400/20 bg-amber-400/[0.08] px-2 py-0.5 text-[11px] font-semibold text-amber-200">
          PRO
        </span>
      </div>

      <div className="relative mt-3 px-4 sm:px-6 lg:px-0">
        <div
          className="flex gap-3 overflow-x-auto px-0 pb-2 select-none lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0"
          aria-hidden="true"
          style={{
            scrollSnapType: "x mandatory",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}
        >
          {rows.map((row, i) => (
            <div
              key={`${row.codename}-${i}`}
              className="relative flex w-[172px] shrink-0 flex-col rounded-[1.05rem] border border-white/[0.04] bg-[#0D0D0D] p-3.5 lg:w-auto"
              style={{ filter: "blur(7px)", scrollSnapAlign: "start" }}
            >
              <div className="aspect-[63/88] w-full rounded-[1rem] bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.07),transparent_58%),linear-gradient(180deg,#111827,#0B0B0B)]" />
              <div className="mt-3">
                <p className="line-clamp-2 text-[14px] font-bold leading-tight text-[#ECECEC]">
                  {row.codename}
                </p>
                <p className="mt-1 truncate text-sm text-zinc-500">
                  {row.set}
                </p>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[14px] font-bold tabular-nums text-[#F0F0F0]">{row.price}</span>
                <span className="text-[13px] font-semibold tabular-nums text-[#7DD3FC]">{row.change}</span>
              </div>
              <span className="mt-2 inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#FDE68A] bg-amber-400/[0.08]">
                {row.rarity}
              </span>
              <div className="pointer-events-none absolute inset-0 rounded-[1.05rem] border border-white/[0.04]" />
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 sm:px-6 lg:px-0">
          <div className="rounded-full border border-blue-400/20 bg-[linear-gradient(135deg,rgba(96,165,250,0.95),rgba(59,130,246,0.92))] px-5 py-2.5 text-[12px] font-bold tracking-[0.12em] text-white shadow-[0_10px_24px_rgba(59,130,246,0.28)]">
            <span className="sr-only">{description}</span>
            <div className="inline-flex items-center justify-center">
              {buttonLabel}
            </div>
          </div>
        </div>

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_18%,rgba(10,10,10,0.18)_44%,rgba(10,10,10,0.3)_100%)]" />
      </div>
    </section>
  );
}
