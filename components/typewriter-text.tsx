"use client";

import { useEffect, useState } from "react";

type TypewriterTextProps = {
  text: string;
  className?: string;
  as?: "p" | "div" | "span";
  speedMs?: number;
};

export default function TypewriterText({
  text,
  className,
  as = "p",
  speedMs = 13,
}: TypewriterTextProps) {
  const [visibleLength, setVisibleLength] = useState(0);

  useEffect(() => {
    const trimmed = text ?? "";
    setVisibleLength(0);

    if (!trimmed) return;

    const reduceMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion) {
      setVisibleLength(trimmed.length);
      return;
    }

    let frame: ReturnType<typeof setTimeout> | null = null;

    function tick(nextLength: number) {
      setVisibleLength(nextLength);
      if (nextLength >= trimmed.length) return;
      frame = setTimeout(() => tick(nextLength + 1), speedMs);
    }

    tick(1);

    return () => {
      if (frame !== null) clearTimeout(frame);
    };
  }, [speedMs, text]);

  const Tag = as;

  return (
    <Tag className={className}>
      {text.slice(0, visibleLength)}
    </Tag>
  );
}
