import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type SnapshotRow = {
  id: string;
  cert: string;
  fetched_at: string;
  source: string;
  parsed: {
    year?: number | null;
    set_name?: string | null;
    subject?: string | null;
    variety?: string | null;
    grade?: string | null;
    label?: string | null;
    total_population?: number | null;
    population_higher?: number | null;
  };
  hash: string;
};

type ActivityEvent = {
  type: string;
  summary: string;
  occurred_at: string;
  details: Record<string, unknown>;
};

function sanitizeCert(cert: string | null): string {
  return (cert ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function diffSnapshots(newer: SnapshotRow, older: SnapshotRow): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const newTotal = asNum(newer.parsed?.total_population);
  const oldTotal = asNum(older.parsed?.total_population);
  if (newTotal !== oldTotal) {
    events.push({
      type: "population_total_changed",
      summary: `Population changed: total ${oldTotal ?? "—"} -> ${newTotal ?? "—"}`,
      occurred_at: newer.fetched_at,
      details: { before: oldTotal, after: newTotal },
    });
  }

  const newHigher = asNum(newer.parsed?.population_higher);
  const oldHigher = asNum(older.parsed?.population_higher);
  if (newHigher !== oldHigher) {
    events.push({
      type: "population_higher_changed",
      summary: `Population higher changed: ${oldHigher ?? "—"} -> ${newHigher ?? "—"}`,
      occurred_at: newer.fetched_at,
      details: { before: oldHigher, after: newHigher },
    });
  }

  const gradeChanges: Record<string, { before: string | number | null; after: string | number | null }> = {};
  const compareFields = ["grade", "label", "year", "set_name", "subject", "variety"] as const;
  for (const field of compareFields) {
    const newerVal = field === "year" ? asNum(newer.parsed?.[field]) : asText(newer.parsed?.[field]);
    const olderVal = field === "year" ? asNum(older.parsed?.[field]) : asText(older.parsed?.[field]);
    if (newerVal !== olderVal) {
      gradeChanges[field] = { before: olderVal, after: newerVal };
    }
  }

  const changedKeys = Object.keys(gradeChanges);
  if (changedKeys.length > 0) {
    events.push({
      type: "classification_changed",
      summary: `Profile fields changed: ${changedKeys.join(", ")}`,
      occurred_at: newer.fetched_at,
      details: gradeChanges,
    });
  }

  return events;
}

export async function GET(req: Request) {
  const cert = sanitizeCert(new URL(req.url).searchParams.get("cert"));
  const limitQuery = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitQuery) ? Math.min(Math.max(limitQuery, 1), 100) : 20;

  if (!cert) {
    return NextResponse.json({ ok: false, error: "Missing cert query param." }, { status: 400 });
  }

  try {
    const supabase = getServerSupabaseClient();
    const { data, error } = await supabase
      .from("psa_cert_snapshots")
      .select("id, cert, fetched_at, source, parsed, hash")
      .eq("cert", cert)
      .order("fetched_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed reading psa_cert_snapshots: ${error.message}`);
    }

    const snapshots = (data ?? []) as SnapshotRow[];
    const events: ActivityEvent[] = [];

    for (let i = 0; i < snapshots.length; i += 1) {
      const current = snapshots[i];
      events.push({
        type: "psa_fetch",
        summary: "Fetched from PSA",
        occurred_at: current.fetched_at,
        details: { source: current.source, snapshot_hash: current.hash },
      });

      const older = snapshots[i + 1];
      if (older) {
        events.push(...diffSnapshots(current, older));
      }
    }

    events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

    return NextResponse.json({
      ok: true,
      cert,
      snapshot_count: snapshots.length,
      snapshots,
      events,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, cert, error: toErrorMessage(error) }, { status: 500 });
  }
}

