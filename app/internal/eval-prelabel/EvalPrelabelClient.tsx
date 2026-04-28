"use client";

/**
 * Bulk pre-labeling UI.
 *
 * Workflow:
 *   1. Drag/drop or pick a batch of card photos.
 *   2. Each one is uploaded to /api/admin/scan-eval/pre-label.
 *      Gemini reads the card; the server returns ranked
 *      canonical_slug candidates.
 *   3. The UI renders a queue: image on the left, top candidate
 *      + alternates on the right, notes chips, accept/skip buttons.
 *   4. Accept saves via /api/admin/scan-eval/promote with
 *      image_base64 + chosen slug + notes.
 *   5. The card disappears from the queue when done.
 *
 * Designed for keyboard-driven review: ENTER to accept top
 * candidate, S to skip, 1-5 to pick alternate. Heavy use is
 * tap-tap-tap.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types matching the server response shapes ─────────────────────

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

type PreLabelResponse = {
  ok: boolean;
  image_hash: string;
  image_bytes_size: number;
  vlm_guess: VlmGuess;
  candidates: Candidate[];
  match_quality: "exact" | "fuzzy" | "name-only" | "unmatched";
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
  id: string; // local-only — UUID-like, generated client-side
  file: File;
  previewUrl: string; // object URL for the <img>
  base64: string; // cached for save
  status: "uploading" | "ready" | "saving" | "saved" | "skipped" | "error";
  preLabel?: PreLabelResponse;
  selectedSlug?: string; // current pick — defaults to top candidate
  notes: string; // condition tag (clean / hand-held / corner-finger / etc.)
  errorMessage?: string;
  // Manual search override — when set, replaces preLabel.candidates
  // for this item. Used when none of Gemini's suggestions are right.
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

// Concurrency cap for parallel pre-label uploads. Vercel's edge
// network handles this fine; the bottleneck is Gemini's rate limits.
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
      // Strip the "data:image/jpeg;base64," prefix.
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

export default function EvalPrelabelClient() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  // ── Pre-label pipeline ─────────────────────────────────────────────

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

  // Add files to queue + kick off pre-label on a bounded concurrency.
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

      // Worker-pool pattern: take items off a shared list with bounded concurrency.
      let cursor = 0;
      const worker = async () => {
        while (cursor < newItems.length) {
          const idx = cursor++;
          const item = newItems[idx]!;
          await runPreLabel(item);
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

  // ── Save (accept) — writes to scan_eval_images via promote ────────

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
        const json = (await resp.json()) as {
          ok: boolean;
          error?: string;
        };
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
    (id: string) => {
      updateItem(id, { status: "skipped" });
    },
    [updateItem],
  );

  // Cleanup object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const item of queueRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  // ── Drag/drop wiring ───────────────────────────────────────────────

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer?.files) {
        void addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  // ── Render ─────────────────────────────────────────────────────────

  const pending = queue.filter((q) => q.status === "uploading" || q.status === "ready");
  const finished = queue.filter((q) => q.status === "saved" || q.status === "skipped");
  const failed = queue.filter((q) => q.status === "error");

  return (
    <div className="flex flex-col gap-6">
      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`rounded-2xl border-2 border-dashed px-8 py-12 text-center transition ${
          isDragOver
            ? "border-blue-400 bg-blue-500/10"
            : "border-[#2A2A2A] bg-white/[0.02]"
        }`}
      >
        <p className="text-[15px] font-semibold text-white">
          Drop card photos here, or
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 inline-flex items-center rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12]"
        >
          Pick files…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              void addFiles(e.target.files);
            }
            e.target.value = "";
          }}
        />
        <p className="mt-3 text-[12px] text-[#6B6B6B]">
          Up to 8 MB per image. Drop a folder of photos at once — Gemini
          pre-labels in parallel (4 at a time).
        </p>
      </div>

      {/* Queue summary */}
      {queue.length > 0 && (
        <div className="flex flex-wrap gap-3 text-[12px] text-[#A3A3A3]">
          <span>
            <span className="font-semibold text-white">{pending.length}</span> pending
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-emerald-400">{finished.filter((q) => q.status === "saved").length}</span> saved
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-zinc-500">{finished.filter((q) => q.status === "skipped").length}</span> skipped
          </span>
          {failed.length > 0 && (
            <>
              <span>·</span>
              <span>
                <span className="font-semibold text-red-400">{failed.length}</span> errored
              </span>
            </>
          )}
        </div>
      )}

      {/* Item cards */}
      <div className="flex flex-col gap-4">
        {queue
          .filter((q) => q.status !== "saved" && q.status !== "skipped")
          .map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onSelectSlug={(slug) => updateItem(item.id, { selectedSlug: slug })}
              onSetNotes={(notes) => updateItem(item.id, { notes })}
              onSetManualOverride={(c) =>
                updateItem(item.id, {
                  manualOverride: c,
                  selectedSlug: c?.slug,
                })
              }
              onSave={() => saveItem(item)}
              onSkip={() => skipItem(item.id)}
            />
          ))}
      </div>
    </div>
  );
}

// ── Single-item card ─────────────────────────────────────────────────

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
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-[#1E1E1E] bg-white/[0.02] p-4 sm:grid-cols-[240px_1fr]">
      {/* Captured image */}
      <div className="flex items-start justify-center">
        <img
          src={item.previewUrl}
          alt="captured card"
          className="max-h-[300px] w-auto rounded-xl object-contain"
        />
      </div>

      {/* Right side — guess + controls */}
      <div className="flex flex-col gap-3">
        {item.status === "uploading" && (
          <p className="text-[13px] text-[#A3A3A3]">Pre-labeling with Gemini…</p>
        )}

        {item.status === "error" && (
          <p className="text-[13px] text-red-400">
            {item.errorMessage ?? "pre-label failed"}
          </p>
        )}

        {(item.status === "ready" || item.status === "saving") && item.preLabel && (
          <>
            {/* VLM guess summary */}
            <div className="rounded-xl border border-[#1E1E1E] bg-black/40 p-3 text-[12px] text-[#A3A3A3]">
              <p className="font-mono">
                <span className="text-[#6B6B6B]">vlm:</span>{" "}
                <span className="text-white">{item.preLabel.vlm_guess.card_name ?? "—"}</span>
                {item.preLabel.vlm_guess.collector_number && (
                  <>
                    {" · "}
                    <span className="text-white">
                      #{item.preLabel.vlm_guess.collector_number}
                    </span>
                  </>
                )}
                {item.preLabel.vlm_guess.set_name && (
                  <>
                    {" · "}
                    <span className="text-white">
                      {item.preLabel.vlm_guess.set_name}
                    </span>
                  </>
                )}
                {" · "}
                <span
                  className={
                    item.preLabel.vlm_guess.confidence === "high"
                      ? "text-emerald-400"
                      : item.preLabel.vlm_guess.confidence === "medium"
                        ? "text-yellow-400"
                        : "text-red-400"
                  }
                >
                  {item.preLabel.vlm_guess.confidence}
                </span>
              </p>
              <p className="mt-1 text-[11px] text-[#6B6B6B]">
                match: {item.preLabel.match_quality}
              </p>
            </div>

            {/* Candidate list */}
            <div className="flex flex-col gap-2">
              {renderedCandidates.length === 0 ? (
                <p className="text-[13px] text-[#A3A3A3]">
                  No candidates matched — search manually below.
                </p>
              ) : (
                renderedCandidates.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={() => onSelectSlug(c.slug)}
                    className={`flex items-center gap-3 rounded-xl border p-2 text-left transition ${
                      item.selectedSlug === c.slug
                        ? "border-blue-400 bg-blue-500/10"
                        : "border-[#1E1E1E] bg-white/[0.02] hover:bg-white/[0.06]"
                    }`}
                  >
                    {c.mirrored_primary_image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.mirrored_primary_image_url}
                        alt={c.canonical_name}
                        className="h-16 w-12 rounded-md object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-white">
                        {c.canonical_name}
                      </p>
                      <p className="truncate text-[11px] text-[#A3A3A3]">
                        {c.set_name ?? "?"} · #{c.card_number ?? "?"}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#6B6B6B]">
                        {c.slug}
                      </p>
                    </div>
                    <span className="text-[11px] text-[#6B6B6B]">
                      {c.match_reason}
                    </span>
                  </button>
                ))
              )}
            </div>

            {/* Manual search */}
            <ManualSearch
              onPick={(c) => onSetManualOverride(c)}
              onClear={() => onSetManualOverride(undefined)}
              hasOverride={hasOverride}
            />

            {/* Notes / condition tag */}
            <div className="flex flex-wrap gap-1.5">
              {CONDITION_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onSetNotes(tag)}
                  className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                    item.notes === tag
                      ? "border-blue-400 bg-blue-500/20 text-blue-100"
                      : "border-[#1E1E1E] bg-white/[0.02] text-[#A3A3A3] hover:bg-white/[0.06]"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSave}
                disabled={!item.selectedSlug || item.status === "saving"}
                className="flex-1 rounded-xl border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-[13px] font-semibold text-emerald-100 transition hover:bg-emerald-500/30 disabled:opacity-40"
              >
                {item.status === "saving" ? "Saving…" : "Accept & save"}
              </button>
              <button
                type="button"
                onClick={onSkip}
                className="rounded-xl border border-[#3A2020] bg-[#201010] px-4 py-2 text-[13px] font-semibold text-[#FFD3D3] transition hover:bg-[#2A1515]"
              >
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Manual slug search (fallback when Gemini's guesses are all wrong)

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
          setResults([]);
          return;
        }
        const json = (await resp.json()) as {
          ok: boolean;
          results?: Array<{
            slug?: string;
            canonical_slug?: string;
            canonical_name?: string;
            name?: string;
            set_name?: string | null;
            card_number?: string | null;
            mirrored_primary_image_url?: string | null;
            primary_image_url?: string | null;
          }>;
        };
        const normalized = (json.results ?? [])
          .map((r) => ({
            slug: r.slug ?? r.canonical_slug ?? "",
            canonical_name: r.canonical_name ?? r.name ?? "",
            set_name: r.set_name ?? null,
            card_number: r.card_number ?? null,
            mirrored_primary_image_url:
              r.mirrored_primary_image_url ?? r.primary_image_url ?? null,
          }))
          .filter((r) => r.slug && r.canonical_name)
          .slice(0, 5);
        setResults(normalized);
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div className="rounded-xl border border-[#1E1E1E] bg-black/30 p-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search manually if none of the candidates are right…"
          className="w-full rounded-md bg-white/[0.04] px-3 py-1.5 text-[13px] text-white placeholder-[#6B6B6B] focus:outline-none"
        />
        {hasOverride && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setQuery("");
            }}
            className="text-[11px] text-[#A3A3A3] hover:text-white"
          >
            Clear
          </button>
        )}
      </div>
      {searching && (
        <p className="mt-1 px-1 text-[11px] text-[#6B6B6B]">Searching…</p>
      )}
      {results.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {results.map((r) => (
            <button
              key={r.slug}
              type="button"
              onClick={() => {
                onPick(r);
                setQuery("");
                setResults([]);
              }}
              className="flex items-center gap-2 rounded-md bg-white/[0.02] px-2 py-1 text-left hover:bg-white/[0.06]"
            >
              {r.mirrored_primary_image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.mirrored_primary_image_url}
                  alt={r.canonical_name}
                  className="h-10 w-7 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-white">{r.canonical_name}</p>
                <p className="truncate text-[10px] text-[#6B6B6B]">
                  {r.set_name ?? "?"} · #{r.card_number ?? "?"}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
