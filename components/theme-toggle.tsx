"use client";

import { useTheme } from "@/app/theme-provider";
import { useEffect, useRef, useState } from "react";

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="btn-ghost inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold"
      >
        <span>🎨</span>
        <span>Theme</span>
      </button>

      {open ? (
        <div className="card absolute right-0 mt-2 w-52 rounded-2xl p-2">
          <p className="text-muted px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">Theme</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setTheme("indigo");
                setOpen(false);
              }}
              className={`rounded-xl px-2.5 py-2 text-xs font-semibold transition ${
                theme === "indigo" ? "bg-accent text-on-accent" : "btn-ghost"
              }`}
            >
              Indigo
            </button>
            <button
              type="button"
              onClick={() => {
                setTheme("finviz");
                setOpen(false);
              }}
              className={`rounded-xl px-2.5 py-2 text-xs font-semibold transition ${
                theme === "finviz" ? "bg-accent text-on-accent" : "btn-ghost"
              }`}
            >
              Finviz
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
