"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

type ViewMode = "RAW" | "GRADED";

export default function CardModeToggle({
  activeMode,
  rawHref,
  gradedHref,
}: {
  activeMode: ViewMode;
  rawHref: string;
  gradedHref: string;
}) {
  const router = useRouter();
  const [optimisticMode, setOptimisticMode] = useState<ViewMode>(activeMode);
  const [pending, setPending] = useState(false);

  function handleSelect(nextMode: ViewMode, href: string) {
    if (pending || optimisticMode === nextMode) return;
    setOptimisticMode(nextMode);
    setPending(true);
    startTransition(() => {
      router.replace(href, { scroll: false });
      setTimeout(() => setPending(false), 900);
    });
  }

  return (
    <div className="rounded-full border border-[#1E1E1E] bg-[#0D0D0D] p-1">
      <div className="flex items-center gap-1">
        {([
          { key: "RAW", href: rawHref },
          { key: "GRADED", href: gradedHref },
        ] as const).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => handleSelect(item.key, item.href)}
            disabled={pending && optimisticMode === item.key}
            className={[
              "inline-flex min-h-8 items-center justify-center rounded-full px-3 text-[12px] font-semibold uppercase tracking-[0.12em] transition",
              optimisticMode === item.key
                ? "bg-[#222222] text-[#F0F0F0] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                : "text-[#6B6B6B] hover:text-[#D0D0D0]",
              pending ? "opacity-90" : "",
            ].join(" ")}
          >
            {item.key}
          </button>
        ))}
      </div>
    </div>
  );
}
