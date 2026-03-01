"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildHighlightSegments, extractHighlightTokens } from "@/lib/search/highlight.mjs";
import { useCardSearch } from "@/lib/search/use-card-search";

type CardSearchProps = {
  initialValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
  enableGlobalShortcut?: boolean;
  size?: "nav" | "hero" | "search";
  showSubmitButton?: boolean;
  submitMode?: "active-only" | "active-or-search";
  className?: string;
};

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function SearchSpinner() {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
      <span
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
        aria-hidden="true"
      />
      <span>Searching cards…</span>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="space-y-2 px-3 py-3" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-2xl border-app border bg-surface-soft/35 px-3 py-2">
          <div className="h-11 w-8 shrink-0 rounded-lg bg-surface/80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-28 rounded-full bg-surface/80" />
            <div className="h-2.5 w-40 rounded-full bg-surface/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function HighlightedText({
  text,
  tokens,
}: {
  text: string | null;
  tokens: string[];
}) {
  const segments = buildHighlightSegments(text ?? "", tokens);

  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${segment.text}-${index}`}
            className="rounded-sm px-0.5"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
              color: "var(--color-text)",
            }}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export default function CardSearch({
  initialValue = "",
  placeholder = "Search cards…",
  autoFocus = false,
  enableGlobalShortcut = false,
  size = "nav",
  showSubmitButton = true,
  submitMode = "active-only",
  className,
}: CardSearchProps) {
  const router = useRouter();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { results, isLoading, error, hasSearched } = useCardSearch(value);
  const highlightTokens = extractHighlightTokens(value);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    if (!enableGlobalShortcut) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      inputRef.current?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enableGlobalShortcut]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      setIsFocused(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const hasQuery = value.trim().length > 0;
  const shouldOpen = isFocused && hasQuery && (isLoading || hasSearched || !!error);
  const resolvedActiveIndex =
    activeIndex >= 0 && results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1;
  const activeResult = resolvedActiveIndex >= 0 ? results[resolvedActiveIndex] : null;

  function closeDropdown() {
    setIsFocused(false);
    setActiveIndex(-1);
  }

  function navigateToResult(slug: string) {
    closeDropdown();
    router.push(`/cards/${encodeURIComponent(slug)}`);
  }

  function submitSearch() {
    const trimmed = value.trim();
    if (!trimmed) {
      closeDropdown();
      return;
    }

    if (/^\d+$/.test(trimmed)) {
      closeDropdown();
      router.push(`/cert/${encodeURIComponent(trimmed)}`);
      return;
    }

    if (activeResult) {
      navigateToResult(activeResult.canonical_slug);
      return;
    }

    if (submitMode === "active-or-search") {
      closeDropdown();
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      return;
    }
  }

  const sizeClasses = size === "search"
    ? {
        bubble: "h-16 rounded-full pl-7 pr-2",
        input: "text-[17px]",
        iconBtn: "h-11 w-11",
        iconSvg: "h-5 w-5",
        dropdown: "top-[calc(100%+0.75rem)] rounded-3xl",
      }
    : size === "hero"
      ? {
          bubble: "h-[60px] rounded-full pl-7 pr-2",
          input: "text-lg",
          iconBtn: "h-11 w-11",
          iconSvg: "h-5 w-5",
          dropdown: "top-[calc(100%+0.75rem)] rounded-3xl",
        }
      : {
          bubble: "h-9 rounded-full pl-4 pr-1",
          input: "text-sm",
          iconBtn: "h-7 w-7",
          iconSvg: "h-3.5 w-3.5",
          dropdown: "top-[calc(100%+0.5rem)] rounded-2xl",
        };

  return (
    <div ref={rootRef} className={joinClasses("relative min-w-0", className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
        className={joinClasses("search-bubble input-themed flex min-w-0 items-center gap-1", sizeClasses.bubble)}
        role="search"
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setIsFocused(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setIsFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              if (results.length > 0) {
                event.preventDefault();
                setIsFocused(true);
                setActiveIndex((current) => (current < 0 ? 0 : Math.min(current + 1, results.length - 1)));
              }
              return;
            }

            if (event.key === "ArrowUp") {
              if (results.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => (current < 0 ? results.length - 1 : Math.max(current - 1, 0)));
              }
              return;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              submitSearch();
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              closeDropdown();
              inputRef.current?.blur();
            }
          }}
          placeholder={placeholder}
          className={joinClasses("min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--color-muted)]", sizeClasses.input)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shouldOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeResult ? `${listboxId}-${activeResult.canonical_slug}` : undefined}
        />
        <button
          type="button"
          className={joinClasses(
            "flex shrink-0 items-center justify-center rounded-full transition text-[var(--color-muted)] hover:text-[var(--color-text)]",
            sizeClasses.iconBtn,
          )}
          aria-label="Camera search"
        >
          <svg className={sizeClasses.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
        {showSubmitButton ? (
          <button
            type="submit"
            className={joinClasses(
              "btn-accent flex shrink-0 items-center justify-center rounded-full",
              sizeClasses.iconBtn,
            )}
            aria-label="Search"
          >
            <svg className={sizeClasses.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        ) : null}
      </form>

      {shouldOpen ? (
        <div
          className={joinClasses(
            "results-enter absolute left-0 right-0 z-50 overflow-hidden border-app border bg-surface",
            sizeClasses.dropdown,
          )}
        >
          {isLoading ? (
            <div>
              <SearchSpinner />
              <SearchSkeleton />
            </div>
          ) : error ? (
            <div className="px-4 py-3 text-sm">
              <p className="text-app font-semibold">Search unavailable</p>
              <p className="text-muted mt-1 text-xs">Keep typing to retry.</p>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-sm">
              <p className="text-app font-semibold">No cards found</p>
              <p className="text-muted mt-1 text-xs">Try another name, set, or card number.</p>
            </div>
          ) : (
            <ul
              id={listboxId}
              role="listbox"
              className="max-h-[min(60vh,22rem)] overflow-y-auto p-2"
            >
              {results.map((result, index) => {
                const isActive = index === resolvedActiveIndex;
                return (
                  <li key={result.canonical_slug} role="presentation">
                    <button
                      id={`${listboxId}-${result.canonical_slug}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => navigateToResult(result.canonical_slug)}
                      className={joinClasses(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition",
                        isActive
                          ? "bg-surface-soft/80"
                          : "hover:bg-surface-soft/55",
                      )}
                    >
                      <div className="h-12 w-9 shrink-0 overflow-hidden rounded-xl border-app border bg-surface-soft/30">
                        {result.primary_image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={result.primary_image_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-muted">
                            N/A
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-app">
                          <HighlightedText text={result.canonical_name} tokens={highlightTokens} />
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          <HighlightedText text={result.set_name ?? "Unknown set"} tokens={highlightTokens} />
                          {result.card_number ? (
                            <>
                              <span> • </span>
                              <HighlightedText text={`#${result.card_number}`} tokens={highlightTokens} />
                            </>
                          ) : null}
                          {result.year ? (
                            <>
                              <span> • </span>
                              <HighlightedText text={String(result.year)} tokens={highlightTokens} />
                            </>
                          ) : null}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
