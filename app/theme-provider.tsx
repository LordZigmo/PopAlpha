"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;                 // user preference
  resolvedTheme: ResolvedTheme; // actual applied theme
  setTheme: (t: Theme) => void;
};

const STORAGE_KEY = "popalpha-theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function safeReadStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // ignore
  }
  return "system";
}

function safeWriteStoredTheme(t: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // ignore
  }
}

function applyThemeToDOM(actual: ResolvedTheme) {
  const root = document.documentElement;

  // Explicit set (no toggle) — prevents "stuck dark" issues
  root.classList.remove("dark");
  if (actual === "dark") root.classList.add("dark");

  // Makes native controls (inputs, scrollbars in some UAs) match
  root.style.colorScheme = actual;

  // Premium touch: prevents color transitions from flashing on initial load,
  // but allows smooth transitions after the first paint.
  // (We set a data-attr you can optionally use in CSS later.)
  root.dataset.theme = actual;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize from storage synchronously to avoid a "flash" on first render
  const [theme, setThemeState] = useState<Theme>(() => safeReadStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    // During SSR this component won't run, but on first client render we can compute.
    // If user preference is system, resolve immediately.
    if (typeof window === "undefined") return "light";
    return theme === "system" ? getSystemTheme() : (theme as ResolvedTheme);
  });

  const resolve = useCallback(
    (t: Theme): ResolvedTheme => (t === "system" ? getSystemTheme() : (t as ResolvedTheme)),
    []
  );

  // Apply whenever preference changes
  useEffect(() => {
    const actual = resolve(theme);
    setResolvedTheme(actual);
    applyThemeToDOM(actual);

    // Smooth transitions for theme changes (premium feel) without "flash" on load
    const root = document.documentElement;
    root.classList.add("theme-transition");
    const id = window.setTimeout(() => root.classList.remove("theme-transition"), 250);

    return () => window.clearTimeout(id);
  }, [theme, resolve]);

  // If user is on "system", respond to OS changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    const onChange = () => {
      if (theme !== "system") return;
      const actual = resolve("system");
      setResolvedTheme(actual);
      applyThemeToDOM(actual);

      const root = document.documentElement;
      root.classList.add("theme-transition");
      const id = window.setTimeout(() => root.classList.remove("theme-transition"), 250);
      return () => window.clearTimeout(id);
    };

    // Safari fallback
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);

    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, [theme, resolve]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    safeWriteStoredTheme(t);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}