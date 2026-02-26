"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/app/theme-provider";

function IOSSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl
                 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
      aria-pressed={checked}
    >
      <span className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-100">
        <span className="text-base">{checked ? "🌙" : "☀️"}</span>
        {label}
      </span>

      <span
        className={[
          "relative inline-flex h-6 w-11 items-center rounded-full transition",
          checked ? "bg-neutral-900 dark:bg-neutral-200" : "bg-neutral-300 dark:bg-neutral-700",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-5 w-5 transform rounded-full bg-white transition shadow",
            checked ? "translate-x-5" : "translate-x-1",
          ].join(" ")}
        />
      </span>
    </button>
  );
}

export default function SettingsMenu() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const isDark = resolvedTheme === "dark";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm
                   border border-neutral-200 bg-white hover:bg-neutral-50
                   dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800
                   transition"
      >
        <span>⚙️</span>
        <span>Settings</span>
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-72 rounded-2xl border border-neutral-200 bg-white shadow-xl p-2
                     dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="px-3 py-2">
            <div className="text-xs font-semibold tracking-wide text-neutral-500 dark:text-neutral-400">
              Appearance
            </div>
          </div>

          <IOSSwitch
            checked={isDark}
            onChange={(v) => setTheme(v ? "dark" : "light")}
            label="Dark Mode"
          />

          <div className="mt-1 px-1">
            <button
              type="button"
              onClick={() => setTheme("system")}
              className={[
                "w-full px-3 py-2 rounded-xl text-left text-sm transition",
                theme === "system"
                  ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200",
              ].join(" ")}
            >
              🖥️ Use System Setting
            </button>
          </div>

          <div className="px-3 pt-2 pb-1 text-xs text-neutral-500 dark:text-neutral-400">
            Current: <span className="font-medium">{resolvedTheme}</span>
          </div>
        </div>
      )}
    </div>
  );
}