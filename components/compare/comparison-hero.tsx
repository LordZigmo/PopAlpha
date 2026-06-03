type ComparisonHeroProps = {
  h1: string;
  subtitle: string;
  lead: string;
};

export default function ComparisonHero({ h1, subtitle, lead }: ComparisonHeroProps) {
  return (
    <div>
      <h1 className="text-[32px] font-semibold leading-[1.1] tracking-[-0.02em] text-white sm:text-[40px]">
        {h1}
      </h1>
      <p className="mt-3 text-[16px] leading-7 text-[#8A8A8E] sm:text-[17px]">{subtitle}</p>
      <p className="mt-8 text-[17px] leading-8 text-[#CFCFCF]">{lead}</p>
    </div>
  );
}
