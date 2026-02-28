"use client";

import { useState } from "react";

type RunSummary = {
  ok: boolean;
  run_id?: string;
  pagesProcessed?: number;
  itemsFetched?: number;
  itemsUpserted?: number;
  itemsFailed?: number;
  dryRun?: boolean;
  error?: string;
};

export default function AdminImportRunner() {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  async function runImport() {
    setRunning(true);
    setSummary(null);
    try {
      const response = await fetch("/api/admin/import/pokemontcg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as RunSummary;
      setSummary(payload);
    } catch (error) {
      setSummary({ ok: false, error: String(error) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void runImport()}
        disabled={running}
        className="btn-accent rounded-[var(--radius-input)] border px-4 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {running ? "Importing..." : "Import English Pokemon"}
      </button>

      {summary ? (
        <p className={`mt-2 text-sm ${summary.ok ? "text-positive" : "text-negative"}`}>
          {summary.ok
            ? `Run ${summary.run_id}: pages ${summary.pagesProcessed}, fetched ${summary.itemsFetched}, upserted ${summary.itemsUpserted}, failed ${summary.itemsFailed}${summary.dryRun ? " (dry run)" : ""}.`
            : `Import failed: ${summary.error ?? "Unknown error"}`}
        </p>
      ) : null}
    </div>
  );
}
