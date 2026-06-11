/**
 * Cron: snapshot-psa-pop
 *
 * Daily PSA population snapshots via the official Public API
 * (GET /publicapi/pop/GetPSASpecPopulation/{specID}). Population history
 * cannot be backfilled from any grader — the industry builds "pop over
 * time" by snapshotting current pops daily and diffing — so this cron's
 * job is simply to keep the clock ticking: one dated row per spec per
 * day in psa_spec_pop_snapshots.
 *
 * Budgeted rotation: PSA's free tier is ~100 calls/day SHARED with live
 * cert lookups (slab scans), so the cron takes a conservative slice
 * (default 60, env PSA_POP_DAILY_BUDGET or ?budget= override) and walks
 * psa_spec_targets oldest-snapshot-first (nulls first, then priority).
 * Targets are harvested from cert lookups — every scanned slab feeds the
 * rotation — plus the migration seed of all previously-seen SpecIDs.
 *
 * Failure semantics: per-spec failures are tolerated and reported (the
 * spec keeps its stale last_snapshot_on, so it retries next run); a 404
 * deactivates the target (retired/unknown spec) so it can't hog budget.
 * If EVERY call fails the run returns HTTP 500 so Vercel's cron-failure
 * alerting fires — that signature is a dead token or exhausted quota,
 * not a data condition.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { getSpecPopulation } from "@/lib/psa/client";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_DAILY_BUDGET = 60;
const MAX_BUDGET = 95;
// Gentle pacing between calls — PSA publishes no per-minute limit, and
// the run window (300s) comfortably fits the budget at this cadence.
const INTER_CALL_DELAY_MS = 250;

type TargetRow = {
  spec_id: number;
  description: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBudget(req: Request): number {
  const param = new URL(req.url).searchParams.get("budget");
  const envBudget = Number.parseInt(process.env.PSA_POP_DAILY_BUDGET ?? "", 10);
  const requested = Number.parseInt(param ?? "", 10);
  const base = Number.isInteger(requested) && requested > 0
    ? requested
    : Number.isInteger(envBudget) && envBudget > 0
      ? envBudget
      : DEFAULT_DAILY_BUDGET;
  return Math.max(1, Math.min(base, MAX_BUDGET));
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const budget = resolveBudget(req);
  const todayUtc = new Date().toISOString().slice(0, 10);

  // Optional single-spec mode for manual verification:
  // /api/cron/snapshot-psa-pop?specId=12345
  const specIdParam = new URL(req.url).searchParams.get("specId");
  const manualSpecId = specIdParam ? Number.parseInt(specIdParam, 10) : null;

  try {
    let targets: TargetRow[];
    if (manualSpecId && Number.isInteger(manualSpecId) && manualSpecId > 0) {
      targets = [{ spec_id: manualSpecId, description: null }];
    } else {
      const { data, error } = await supabase
        .from("psa_spec_targets")
        .select("spec_id, description")
        .eq("active", true)
        .or(`last_snapshot_on.is.null,last_snapshot_on.lt.${todayUtc}`)
        .order("last_snapshot_on", { ascending: true, nullsFirst: true })
        .order("priority", { ascending: false })
        .order("spec_id", { ascending: true })
        .limit(budget);
      if (error) throw new Error(`psa_spec_targets(select): ${error.message}`);
      targets = data ?? [];
    }

    let snapshotted = 0;
    let deactivated = 0;
    const failures: Array<{ specId: number; error: string }> = [];

    for (const [index, target] of targets.entries()) {
      if (index > 0) await sleep(INTER_CALL_DELAY_MS);
      try {
        const pop = await getSpecPopulation(target.spec_id);

        const { error: upsertError } = await supabase.from("psa_spec_pop_snapshots").upsert(
          {
            spec_id: target.spec_id,
            captured_on: todayUtc,
            description: pop.description,
            total: pop.total,
            auth_count: pop.auth,
            grade_counts: pop.pop ?? {},
            raw: pop.raw,
          },
          { onConflict: "spec_id,captured_on" }
        );
        if (upsertError) throw new Error(`psa_spec_pop_snapshots(upsert): ${upsertError.message}`);

        const { error: markError } = await supabase
          .from("psa_spec_targets")
          .update({
            last_snapshot_on: todayUtc,
            ...(pop.description ? { description: pop.description } : {}),
          })
          .eq("spec_id", target.spec_id);
        if (markError) throw new Error(`psa_spec_targets(update): ${markError.message}`);

        snapshotted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ specId: target.spec_id, error: message.slice(0, 300) });

        // Unknown/retired spec: park it so it stops burning quota. It can
        // be reactivated manually if PSA revives the spec.
        if (message.includes("HTTP 404")) {
          const { error: deactivateError } = await supabase
            .from("psa_spec_targets")
            .update({ active: false })
            .eq("spec_id", target.spec_id);
          if (!deactivateError) deactivated += 1;
        }
      }
    }

    const allFailed = targets.length > 0 && snapshotted === 0;
    if (allFailed) {
      console.error("[snapshot-psa-pop] every call failed — token/quota signature", {
        attempted: targets.length,
        sample: failures.slice(0, 3),
      });
    } else if (failures.length > 0) {
      console.warn("[snapshot-psa-pop] partial failures", {
        attempted: targets.length,
        snapshotted,
        failed: failures.length,
        sample: failures.slice(0, 3),
      });
    }

    return NextResponse.json(
      {
        ok: !allFailed,
        capturedOn: todayUtc,
        budget,
        attempted: targets.length,
        snapshotted,
        failed: failures.length,
        deactivated,
        failures: failures.slice(0, 10),
      },
      { status: allFailed ? 500 : 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[snapshot-psa-pop] run failed", { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
