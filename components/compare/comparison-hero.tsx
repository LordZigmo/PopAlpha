type ComparisonHeroProps = {
  eyebrow: string;
  h1: string;
  updated: string;
};

function formatUpdated(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function ComparisonHero({ eyebrow, h1, updated }: ComparisonHeroProps) {
  return (
    <div className="rounded-[28px] border border-[#1E1E1E] bg-[#101010] p-6 sm:p-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.05em] sm:text-[44px] lg:text-[48px]">
        {h1}
      </h1>
      <p className="mt-4 text-[13px] text-[#6B6B6B]">Updated {formatUpdated(updated)}</p>
    </div>
  );
}
