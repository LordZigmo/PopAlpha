import AdminImportRunner from "@/components/admin-import-runner";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

type IngestRunListRow = {
  id: number;
  status: string;
  ok: boolean;
  items_fetched: number;
  items_upserted: number;
  items_failed: number;
  error_text: string | null;
  started_at: string;
  ended_at: string | null;
};

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default async function AdminImportPage() {
  let runs: IngestRunListRow[] = [];
  try {
    const supabase = getServerSupabaseClient();
    const { data } = await supabase
      .from("ingest_runs")
      .select("id, status, ok, items_fetched, items_upserted, items_failed, error_text, started_at, ended_at")
      .eq("job", "pokemontcg_import_en")
      .order("started_at", { ascending: false })
      .limit(10);
    runs = (data ?? []) as IngestRunListRow[];
  } catch {
    runs = [];
  }

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <h1 className="text-app text-2xl font-semibold tracking-tight">Admin Import</h1>
          <p className="text-muted mt-2 text-sm">Pokemon TCG API (English)</p>
          <div className="mt-3">
            <AdminImportRunner />
          </div>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Recent Runs</p>
          {runs.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No runs yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {runs.map((run) => (
                <li key={run.id} className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                  <p className="text-app text-sm font-semibold">
                    Run #{run.id} • {run.status} • {run.ok ? "OK" : "Not OK"}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    Fetched {run.items_fetched} • Upserted {run.items_upserted} • Failed {run.items_failed}
                  </p>
                  <p className="text-muted mt-1 text-xs">Started {formatTime(run.started_at)} • Ended {formatTime(run.ended_at)}</p>
                  {run.error_text ? <p className="text-negative mt-1 text-xs">{run.error_text}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
