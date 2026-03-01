"use client";

import { useEffect, useRef, useState } from "react";

type CardStyle = "terminal" | "glass";

const STORAGE_KEY = "popalpha-card-style";

function applyStyle(style: CardStyle) {
  document.documentElement.setAttribute("data-style", style);
}

export default function StyleToggle() {
  const [style, setStyle] = useState<CardStyle>("terminal");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const initial: CardStyle = stored === "glass" ? "glass" : "terminal";
    setStyle(initial);
    applyStyle(initial);
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function pick(next: CardStyle) {
    setStyle(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyStyle(next);
    setOpen(false);
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#1E1E1E]/50 bg-[#0A0A0A]/90 px-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#555] backdrop-blur-sm transition hover:text-[#999]"
        aria-label="Card style"
      >
        {style === "terminal" ? "Terminal" : "Glass"}
      </button>

      {open && (
        <div className="card absolute right-0 z-50 mt-1 w-36 rounded-xl p-1.5">
          {(["terminal", "glass"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => pick(option)}
              className={[
                "flex w-full items-center rounded-lg px-3 py-2 text-[13px] font-semibold transition",
                style === option
                  ? "bg-accent text-on-accent"
                  : "text-[#999] hover:text-[#F0F0F0]",
              ].join(" ")}
            >
              {option === "terminal" ? "Terminal" : "Glass"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
