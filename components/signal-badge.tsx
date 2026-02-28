type SignalTone = "neutral" | "positive" | "negative" | "warning";

const TONE_CLASS: Record<SignalTone, string> = {
  neutral: "border-app bg-surface-soft/60 text-muted",
  positive: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
  negative: "border-rose-400/30 bg-rose-500/10 text-rose-200",
  warning: "border-amber-400/30 bg-amber-500/10 text-amber-200",
};

export default function SignalBadge({
  label,
  tone = "neutral",
  prominent = false,
}: {
  label: string;
  tone?: SignalTone;
  prominent?: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-3 py-1 font-semibold",
        prominent ? "text-xs" : "text-[11px]",
        TONE_CLASS[tone],
      ].join(" ")}
    >
      {label}
    </span>
  );
}
