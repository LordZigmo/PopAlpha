type QuickAnswerBoxProps = {
  text: string;
};

export default function QuickAnswerBox({ text }: QuickAnswerBoxProps) {
  return (
    <section className="mt-6 rounded-[28px] border border-[#00B4D8]/30 bg-[#0B1418] p-6 sm:p-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00B4D8]">
        Quick answer
      </p>
      <p className="mt-3 text-[16px] leading-7 text-[#E6E6E6] sm:text-[17px]">{text}</p>
    </section>
  );
}
