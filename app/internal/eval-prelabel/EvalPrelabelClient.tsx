"use client";

/**
 * Bulk pre-labeling UI — simplified.
 *
 * Drop photos → pre-label via Gemini → confirm/edit → save to
 * scan_eval_images. Inline styles only (no Tailwind dependency)
 * so layout is robust regardless of global CSS state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types matching server response shapes ─────────────────────────

type VlmGuess = {
  is_pokemon_tcg: boolean;
  card_name: string | null;
  set_name: string | null;
  set_code: string | null;
  collector_number_full: string | null;
  collector_number: string | null;
  card_kind: "pokemon" | "trainer" | "energy" | "unknown";
  confidence: "high" | "medium" | "low";
};

type Candidate = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  language: string | null;
  mirrored_primary_image_url: string | null;
  match_score: number;
  match_reason: string;
};

type AlreadySavedInfo = {
  eval_image_id: string;
  canonical_slug: string;
  captured_source: string;
  captured_language: string;
  notes: string | null;
  created_at: string;
};

type PreLabelResponse = {
  ok: boolean;
  image_hash: string;
  image_bytes_size: number;
  vlm_guess: VlmGuess | null;
  candidates: Candidate[];
  match_quality: "exact" | "fuzzy" | "name-only" | "unmatched";
  already_saved: AlreadySavedInfo | null;
  error?: string;
};

type SearchCandidate = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  mirrored_primary_image_url: string | null;
};

type QueueItem = {
  id: string;
  file: File;
  previewUrl: string;
  base64: string;
  status:
    | "uploading"
    | "ready"
    | "saving"
    | "saved"
    | "skipped"
    | "error"
    | "already-saved"; // server detected this image hash is already in scan_eval_images
  preLabel?: PreLabelResponse;
  selectedSlug?: string;
  notes: string;
  errorMessage?: string;
  manualOverride?: SearchCandidate;
};

const CONDITION_TAGS = [
  "clean",
  "hand-held",
  "corner-finger",
  "top-finger",
  "right-finger",
  "angled",
  "dim",
  "glare",
] as const;

const MAX_CONCURRENT_PRELABEL = 4;

function generateLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

// ── Inline style helpers (no Tailwind dependency) ───────────────────

const colors = {
  bg: "#0a0a0a",
  surface: "#141414",
  surfaceAlt: "#1c1c1c",
  border: "#2a2a2a",
  borderAccent: "#3b82f6",
  text: "#fff",
  textMuted: "#aaa",
  textDim: "#666",
  green: "#10b981",
  greenBg: "rgba(16,185,129,0.15)",
  red: "#ef4444",
  redBg: "rgba(239,68,68,0.15)",
  yellow: "#fbbf24",
};

const dropZoneStyle = (active: boolean): React.CSSProperties => ({
  border: `3px dashed ${active ? colors.borderAccent : colors.border}`,
  background: active ? "rgba(59,130,246,0.08)" : colors.surface,
  borderRadius: 16,
  padding: "60px 24px",
  textAlign: "center",
  cursor: "pointer",
  transition: "all 0.15s ease",
});

const buttonStyle = (variant: "primary" | "secondary" | "danger"): React.CSSProperties => ({
  border: "1px solid",
  borderColor:
    variant === "primary"
      ? colors.green
      : variant === "danger"
        ? colors.red
        : colors.border,
  background:
    variant === "primary"
      ? colors.greenBg
      : variant === "danger"
        ? colors.redBg
        : colors.surface,
  color:
    variant === "primary"
      ? colors.green
      : variant === "danger"
        ? colors.red
        : colors.text,
  padding: "8px 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

// ── Main component ─────────────────────────────────────────────────

export default function EvalPrelabelClient() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const runPreLabel = useCallback(
    async (item: QueueItem) => {
      try {
        const form = new FormData();
        form.append("image", item.file);
        const resp = await fetch("/api/admin/scan-eval/pre-label", {
          method: "POST",
          body: form,
        });
        const json = (await resp.json()) as PreLabelResponse;
        if (!resp.ok || !json.ok) {
          updateItem(item.id, {
            status: "error",
            errorMessage: json.error ?? `pre-label HTTP ${resp.status}`,
          });
          return;
        }
        // Already-saved short-circuit — server detected this image
        // hash already exists in scan_eval_images. Surface in a
        // distinct "already-saved" state so the operator can see at
        // a glance which photos in a re-upload batch are duplicates
        // vs which are genuinely new and need attention.
        if (json.already_saved) {
          updateItem(item.id, {
            status: "already-saved",
            preLabel: json,
            selectedSlug: json.already_saved.canonical_slug,
          });
          return;
        }
        updateItem(item.id, {
          status: "ready",
          preLabel: json,
          selectedSlug: json.candidates[0]?.slug,
        });
      } catch (err) {
        updateItem(item.id, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateItem],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (fileArr.length === 0) return;

      const newItems: QueueItem[] = await Promise.all(
        fileArr.map(async (file) => ({
          id: generateLocalId(),
          file,
          previewUrl: URL.createObjectURL(file),
          base64: await fileToBase64(file),
          status: "uploading" as const,
          notes: "clean",
        })),
      );
      setQueue((prev) => [...prev, ...newItems]);

      let cursor = 0;
      const worker = async () => {
        while (cursor < newItems.length) {
          const idx = cursor++;
          await runPreLabel(newItems[idx]!);
        }
      };
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT_PRELABEL, newItems.length) },
        () => worker(),
      );
      await Promise.all(workers);
    },
    [runPreLabel],
  );

  const saveItem = useCallback(
    async (item: QueueItem) => {
      if (!item.selectedSlug) return;
      updateItem(item.id, { status: "saving", errorMessage: undefined });
      try {
        const resp = await fetch("/api/admin/scan-eval/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            canonical_slug: item.selectedSlug,
            image_base64: item.base64,
            captured_source: "user_photo",
            notes: item.notes,
          }),
        });
        const json = (await resp.json()) as { ok: boolean; error?: string };
        if (!resp.ok || !json.ok) {
          updateItem(item.id, {
            status: "error",
            errorMessage: json.error ?? `promote HTTP ${resp.status}`,
          });
          return;
        }
        updateItem(item.id, { status: "saved", errorMessage: undefined });
      } catch (err) {
        updateItem(item.id, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateItem],
  );

  const skipItem = useCallback(
    (id: string) => updateItem(id, { status: "skipped" }),
    [updateItem],
  );

  useEffect(() => {
    return () => {
      for (const item of queueRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  const pending = queue.filter((q) => q.status === "uploading" || q.status === "ready");
  const savedCount = queue.filter((q) => q.status === "saved").length;
  const skippedCount = queue.filter((q) => q.status === "skipped").length;
  const alreadySavedCount = queue.filter((q) => q.status === "already-saved").length;
  const erroredCount = queue.filter((q) => q.status === "error").length;
  // already-saved cards stay visible (so operator can see which ones
  // were dedup'd) but render as compact dismiss-able banners rather
  // than full review cards.
  const visibleQueue = queue.filter((q) => q.status !== "saved" && q.status !== "skipped");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Big obvious drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        style={dropZoneStyle(isDragOver)}
      >
        <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
          {isDragOver ? "Drop to upload" : "Drop photos here"}
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
          or click anywhere in this box to pick files
        </div>
        <div style={{ fontSize: 12, color: colors.textDim }}>
          JPEGs / PNGs up to 8 MB each. Drop a folder of photos at once — we
          pre-label 4 at a time in parallel.
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Queue summary */}
      {queue.length > 0 && (
        <div style={{ fontSize: 13, color: colors.textMuted }}>
          <span style={{ color: colors.text, fontWeight: 600 }}>{pending.length}</span> pending ·{" "}
          <span style={{ color: colors.green, fontWeight: 600 }}>{savedCount}</span> saved ·{" "}
          <span style={{ color: colors.textDim, fontWeight: 600 }}>{skippedCount}</span> skipped
          {alreadySavedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: colors.yellow, fontWeight: 600 }}>{alreadySavedCount}</span>{" "}
              already saved
            </>
          )}
          {erroredCount > 0 && (
            <>
              {" · "}
              <span style={{ color: colors.red, fontWeight: 600 }}>{erroredCount}</span> errored
            </>
          )}
        </div>
      )}

      {/* Item cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {visibleQueue.map((item) =>
          item.status === "already-saved" ? (
            <AlreadySavedBanner
              key={item.id}
              item={item}
              onDismiss={() => skipItem(item.id)}
            />
          ) : (
            <ItemCard
              key={item.id}
              item={item}
              onSelectSlug={(slug) => updateItem(item.id, { selectedSlug: slug })}
              onSetNotes={(notes) => updateItem(item.id, { notes })}
              onSetManualOverride={(c) =>
                updateItem(item.id, { manualOverride: c, selectedSlug: c?.slug })
              }
              onSave={() => saveItem(item)}
              onSkip={() => skipItem(item.id)}
            />
          ),
        )}
      </div>

      {/* Bulk-dismiss action when there are several already-saved items */}
      {alreadySavedCount >= 3 && (
        <button
          type="button"
          onClick={() => {
            for (const item of queue) {
              if (item.status === "already-saved") skipItem(item.id);
            }
          }}
          style={{
            ...buttonStyle("secondary"),
            alignSelf: "flex-start",
          }}
        >
          Dismiss all {alreadySavedCount} already-saved items
        </button>
      )}
    </div>
  );
}

// ── Compact "already saved" banner ─────────────────────────────────

function AlreadySavedBanner({
  item,
  onDismiss,
}: {
  item: QueueItem;
  onDismiss: () => void;
}) {
  const slug = item.preLabel?.already_saved?.canonical_slug ?? item.selectedSlug ?? "?";
  const notes = item.preLabel?.already_saved?.notes;
  const createdAt = item.preLabel?.already_saved?.created_at;
  const friendlyDate = createdAt
    ? new Date(createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 10,
        background: "rgba(251,191,36,0.06)",
        border: `1px solid rgba(251,191,36,0.30)`,
        borderRadius: 10,
      }}
    >
      <img
        src={item.previewUrl}
        alt="already saved"
        style={{ height: 56, width: "auto", borderRadius: 4, objectFit: "contain" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: colors.yellow, fontWeight: 600, marginBottom: 2 }}>
          ✓ Already saved
        </div>
        <div
          style={{
            fontSize: 12,
            fontFamily: "ui-monospace,monospace",
            color: colors.text,
            wordBreak: "break-all",
          }}
        >
          {slug}
        </div>
        {(notes || friendlyDate) && (
          <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>
            {[notes, friendlyDate].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          fontSize: 11,
          color: colors.textMuted,
          background: "transparent",
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

// ── Single-item review card ────────────────────────────────────────

function ItemCard({
  item,
  onSelectSlug,
  onSetNotes,
  onSetManualOverride,
  onSave,
  onSkip,
}: {
  item: QueueItem;
  onSelectSlug: (slug: string) => void;
  onSetNotes: (notes: string) => void;
  onSetManualOverride: (c: SearchCandidate | undefined) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const candidates = item.preLabel?.candidates ?? [];
  const hasOverride = !!item.manualOverride;
  const renderedCandidates: Candidate[] = hasOverride
    ? [
        {
          slug: item.manualOverride!.slug,
          canonical_name: item.manualOverride!.canonical_name,
          set_name: item.manualOverride!.set_name,
          card_number: item.manualOverride!.card_number,
          language: null,
          mirrored_primary_image_url: item.manualOverride!.mirrored_primary_image_url,
          match_score: 1.0,
          match_reason: "manual override",
        },
      ]
    : candidates;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 16,
        padding: 16,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
        <img
          src={item.previewUrl}
          alt="captured card"
          style={{ maxHeight: 280, width: "auto", borderRadius: 8, objectFit: "contain" }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {item.status === "uploading" && (
          <div style={{ fontSize: 13, color: colors.textMuted }}>Pre-labeling with Gemini…</div>
        )}

        {item.status === "error" && (
          <div style={{ fontSize: 13, color: colors.red }}>
            {item.errorMessage ?? "pre-label failed"}
          </div>
        )}

        {(item.status === "ready" || item.status === "saving") &&
          item.preLabel &&
          item.preLabel.vlm_guess && (
            <>
              <div
                style={{
                  fontSize: 12,
                  fontFamily: "ui-monospace,monospace",
                  color: colors.textMuted,
                  background: colors.surfaceAlt,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <span style={{ color: colors.textDim }}>vlm:</span>{" "}
                <span style={{ color: colors.text }}>
                  {item.preLabel.vlm_guess.card_name ?? "—"}
                </span>
                {item.preLabel.vlm_guess.collector_number && (
                  <>
                    {" · "}
                    <span style={{ color: colors.text }}>
                      #{item.preLabel.vlm_guess.collector_number}
                    </span>
                  </>
                )}
                {item.preLabel.vlm_guess.set_name && (
                  <>
                    {" · "}
                    <span style={{ color: colors.text }}>{item.preLabel.vlm_guess.set_name}</span>
                  </>
                )}
                {" · "}
                <span
                  style={{
                    color:
                      item.preLabel.vlm_guess.confidence === "high"
                        ? colors.green
                        : item.preLabel.vlm_guess.confidence === "medium"
                          ? colors.yellow
                          : colors.red,
                  }}
                >
                  {item.preLabel.vlm_guess.confidence}
                </span>
                <span style={{ color: colors.textDim }}>
                  {" "}· match: {item.preLabel.match_quality}
                </span>
              </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {renderedCandidates.length === 0 ? (
                <div style={{ fontSize: 13, color: colors.textMuted }}>
                  No matches — search manually below.
                </div>
              ) : (
                renderedCandidates.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={() => onSelectSlug(c.slug)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: 8,
                      background:
                        item.selectedSlug === c.slug ? "rgba(59,130,246,0.12)" : colors.surfaceAlt,
                      border: `1px solid ${
                        item.selectedSlug === c.slug ? colors.borderAccent : colors.border
                      }`,
                      borderRadius: 8,
                      cursor: "pointer",
                      textAlign: "left",
                      color: colors.text,
                    }}
                  >
                    {c.mirrored_primary_image_url && (
                      <img
                        src={c.mirrored_primary_image_url}
                        alt={c.canonical_name}
                        style={{ height: 60, width: 44, borderRadius: 4, objectFit: "cover" }}
                      />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{c.canonical_name}</div>
                      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                        {c.set_name ?? "?"} · #{c.card_number ?? "?"}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: "ui-monospace,monospace",
                          color: colors.textDim,
                          marginTop: 4,
                        }}
                      >
                        {c.slug}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: colors.textDim }}>{c.match_reason}</div>
                  </button>
                ))
              )}
            </div>

            <ManualSearch
              onPick={(c) => onSetManualOverride(c)}
              onClear={() => onSetManualOverride(undefined)}
              hasOverride={hasOverride}
            />

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {CONDITION_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onSetNotes(tag)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 600,
                    background:
                      item.notes === tag ? "rgba(59,130,246,0.2)" : colors.surfaceAlt,
                    border: `1px solid ${
                      item.notes === tag ? colors.borderAccent : colors.border
                    }`,
                    borderRadius: 6,
                    color: item.notes === tag ? "#a8c5ff" : colors.textMuted,
                    cursor: "pointer",
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={onSave}
                disabled={!item.selectedSlug || item.status === "saving"}
                style={{
                  ...buttonStyle("primary"),
                  flex: 1,
                  opacity: !item.selectedSlug || item.status === "saving" ? 0.4 : 1,
                }}
              >
                {item.status === "saving" ? "Saving…" : "Accept & save"}
              </button>
              <button type="button" onClick={onSkip} style={buttonStyle("danger")}>
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Manual slug search ─────────────────────────────────────────────

function ManualSearch({
  onPick,
  onClear,
  hasOverride,
}: {
  onPick: (c: SearchCandidate) => void;
  onClear: () => void;
  hasOverride: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await fetch(`/api/search/cards?q=${encodeURIComponent(query)}`);
        if (!resp.ok) {
          // Surface non-2xx visibly instead of silently emptying the
          // result list — playbook lesson from the silent-fallback
          // postmortem (docs/external-api-failure-modes.md). If the
          // operator sees "search returned 503" they know to retry;
          // a silent empty list looks like "no matches" and they
          // skip the card.
          console.warn(
            `[eval-prelabel] /api/search/cards HTTP ${resp.status} for q="${query}"`,
          );
          setResults([]);
          return;
        }
        const json = (await resp.json()) as {
          ok: boolean;
          cards?: Array<{
            id?: string;
            slug?: string;
            canonical_slug?: string;
            canonical_name?: string;
            name?: string;
            set?: string | null;
            set_name?: string | null;
            card_number?: string | null;
            mirrored_primary_image_url?: string | null;
            primary_image_url?: string | null;
          }>;
          // Older shape — kept defensively in case the endpoint
          // ever changes back, but cards is the current truth.
          results?: unknown[];
        };
        // The /api/search/cards endpoint returns the array under
        // `cards`. (Original code read `results` — that was the bug
        // that made manual search appear to find nothing.)
        const raw = json.cards ?? [];
        const normalized = raw
          .map((r) => ({
            slug: r.slug ?? r.canonical_slug ?? r.id ?? "",
            canonical_name: r.canonical_name ?? r.name ?? "",
            set_name: r.set_name ?? r.set ?? null,
            card_number: r.card_number ?? null,
            mirrored_primary_image_url:
              r.mirrored_primary_image_url ?? r.primary_image_url ?? null,
          }))
          .filter((r) => r.slug && r.canonical_name)
          .slice(0, 8);
        setResults(normalized);
      } catch (err) {
        console.warn(
          `[eval-prelabel] manual search threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div
      style={{
        background: colors.surfaceAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search manually if none of the candidates are right…"
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.04)",
            border: "none",
            borderRadius: 4,
            padding: "6px 10px",
            fontSize: 13,
            color: colors.text,
            outline: "none",
          }}
        />
        {hasOverride && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setQuery("");
            }}
            style={{
              fontSize: 11,
              color: colors.textMuted,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>
      {searching && (
        <div style={{ marginTop: 4, fontSize: 11, color: colors.textDim, padding: "0 4px" }}>
          Searching…
        </div>
      )}
      {results.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {results.map((r) => (
            <button
              key={r.slug}
              type="button"
              onClick={() => {
                onPick(r);
                setQuery("");
                setResults([]);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(255,255,255,0.03)",
                border: "none",
                padding: "4px 8px",
                borderRadius: 4,
                cursor: "pointer",
                textAlign: "left",
                color: colors.text,
              }}
            >
              {r.mirrored_primary_image_url && (
                <img
                  src={r.mirrored_primary_image_url}
                  alt={r.canonical_name}
                  style={{ height: 38, width: 28, borderRadius: 3, objectFit: "cover" }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12 }}>{r.canonical_name}</div>
                <div style={{ fontSize: 10, color: colors.textDim }}>
                  {r.set_name ?? "?"} · #{r.card_number ?? "?"}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
