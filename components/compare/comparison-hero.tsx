type ComparisonHeroProps = {
  h1: string;
  subtitle: string;
  lead: string;
};

export default function ComparisonHero({ h1, subtitle, lead }: ComparisonHeroProps) {
  return (
    <div>
      <h1 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-white sm:text-[48px]">
        {h1}
      </h1>
      <p className="mt-3 text-[18px] leading-7 text-[#8A8A8E] sm:text-[20px]">{subtitle}</p>
      <p className="mt-8 text-[19px] leading-8 text-[#CFCFCF] sm:text-[20px]">{lead}</p>
    </div>
  );
}
