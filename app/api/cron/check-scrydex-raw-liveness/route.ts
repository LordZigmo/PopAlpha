/**
 * Cron: check-scrydex-raw-liveness
 *
 * Health check for the observation→snapshot leg of the Scrydex pipeline,
 * born from the 2026-06-10 Ascended Heroes incident: the provider kept
 * returning RAW (ungraded NM) prices, ingest + normalize + match all
 * stayed green, but the budget-capped timeseries consumer silently
 * starved ~70% of the set — RAW snapshots, charts, and metrics froze for
 * almost a month while every existing health surface reported healthy.
 *
 * The invariant this enforces: if the provider showed us a RAW variant
 * recently (provider_card_map.last_observed_at fresh), its
 * price_snapshots row must also be fresh. A card the provider has gone
 * quiet on is NOT an offender — only "we received it and didn't process
 * it" counts, which is precisely the starvation signature and never a
 * market condition.
 *
 * Scope is the actively-traded 2024+ target sets (bounded query cost;
 * these are also the sets whose volume can outrun the stage budgets).
 * Mirrors check-pricecharting-freshness: FAILS LOUD with HTTP 500 so
 * Vercel's cron-failure alerting fires; the JSON body carries per-set
 * counts plus sample slugs so the operator can jump straight to a
 * /api/cron/write-provider-timeseries?set=... drain.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { SCRYDEX_2024_PLUS_PROVIDER_SET_IDS } from "@/lib/backfill/scrydex-2024plus-targets";

export const runtime = "nodejs";
export const maxDuration = 120;

// "Provider showed us this variant recently": captures run 3-4×/day, so
// 36h tolerates a missed capture without going blind to a real stall.
const FRESH_OBSERVATION_WINDOW_HOURS = 36;
// "And we processed it recently": snapshots upsert on every healthy
// pipeline pass, so 48h (= two missed daily cycles) is already abnormal.
const MAX_SNAPSHOT_LAG_HOURS = 48;
// Per-set alarm floor: a couple of one-off laggards shouldn't page
// anyone; a tenth of a set frozen is the starvation signature.
const STALE_PCT_THRESHOLD = 10;
const STALE_COUNT_FLOOR = 5;

const MAPPING_PAGE_SIZE = 1000;
const SNAPSHOT_REF_CHUNK_SIZE = 200;

type RawMappingRow = {
  provider_variant_id: string;
  canonical_slug: string | null;
  last_observed_at: string | null;
};

type SnapshotRow = {
  provider_ref: string | null;
  observed_at: string;
};

type SetLivenessReport = {
  providerSetId: string;
  freshRawMappings: number;
  staleSnapshots: number;
  stalePct: number;
  unhealthy: boolean;
  sampleStaleSlugs: string[];
};

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const now = Date.now();
  const freshSinceIso = new Date(now - FRESH_OBSERVATION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const snapshotFreshSinceMs = now - MAX_SNAPSHOT_LAG_HOURS * 60 * 60 * 1000;

  try {
    const reports: SetLivenessReport[] = [];

    for (const providerSetId of SCRYDEX_2024_PLUS_PROVIDER_SET_IDS) {
      // 1. RAW variants the provider returned within the fresh window.
      //    Graded variant ids carry a "::GRADED::" segment; RAW ids do
      //    not, so a NOT LIKE filter isolates the ungraded rows the
      //    starved consumer was dropping.
      const mappings: RawMappingRow[] = [];
      for (let from = 0; ; from += MAPPING_PAGE_SIZE) {
        const { data, error } = await supabase
          .from("provider_card_map")
          .select("provider_variant_id, canonical_slug, last_observed_at")
          .eq("provider", "SCRYDEX")
          .eq("provider_set_id", providerSetId)
          .eq("mapping_status", "MATCHED")
          .not("provider_variant_id", "like", "%::GRADED::%")
          .gte("last_observed_at", freshSinceIso)
          .order("provider_variant_id", { ascending: true })
          .range(from, from + MAPPING_PAGE_SIZE - 1)
          .returns<RawMappingRow[]>();
        if (error) throw new Error(`provider_card_map(${providerSetId}): ${error.message}`);
        const rows = data ?? [];
        mappings.push(...rows);
        if (rows.length < MAPPING_PAGE_SIZE) break;
      }

      if (mappings.length === 0) {
        reports.push({
          providerSetId,
          freshRawMappings: 0,
          staleSnapshots: 0,
          stalePct: 0,
          unhealthy: false,
          sampleStaleSlugs: [],
        });
        continue;
      }

      // 2. Latest snapshot per provider_ref ("scrydex:" + variant id —
      //    the upsert key the timeseries stage maintains).
      const refBySlug = new Map<string, string | null>();
      const refs = mappings.map((row) => {
        const ref = `scrydex:${row.provider_variant_id}`;
        refBySlug.set(ref, row.canonical_slug);
        return ref;
      });
      const snapshotObservedAtByRef = new Map<string, number>();
      for (let index = 0; index < refs.length; index += SNAPSHOT_REF_CHUNK_SIZE) {
        const chunk = refs.slice(index, index + SNAPSHOT_REF_CHUNK_SIZE);
        const { data, error } = await supabase
          .from("price_snapshots")
          .select("provider_ref, observed_at")
          .eq("provider", "SCRYDEX")
          .in("provider_ref", chunk)
          .returns<SnapshotRow[]>();
        if (error) throw new Error(`price_snapshots(${providerSetId}): ${error.message}`);
        for (const row of data ?? []) {
          const ref = String(row.provider_ref ?? "").trim();
          if (!ref || !row.observed_at) continue;
          const observedMs = new Date(row.observed_at).getTime();
          if (!Number.isFinite(observedMs)) continue;
          const existing = snapshotObservedAtByRef.get(ref);
          if (existing === undefined || observedMs > existing) {
            snapshotObservedAtByRef.set(ref, observedMs);
          }
        }
      }

      // 3. Offenders: provider gave us the variant recently, snapshot
      //    missing or lagging beyond the threshold.
      const sampleStaleSlugs: string[] = [];
      let staleSnapshots = 0;
      for (const ref of refs) {
        const observedMs = snapshotObservedAtByRef.get(ref);
        if (observedMs !== undefined && observedMs >= snapshotFreshSinceMs) continue;
        staleSnapshots += 1;
        const slug = refBySlug.get(ref);
        if (slug && sampleStaleSlugs.length < 5) sampleStaleSlugs.push(slug);
      }

      const stalePct = (staleSnapshots / mappings.length) * 100;
      reports.push({
        providerSetId,
        freshRawMappings: mappings.length,
        staleSnapshots,
        stalePct: Number(stalePct.toFixed(1)),
        unhealthy: staleSnapshots >= STALE_COUNT_FLOOR && stalePct > STALE_PCT_THRESHOLD,
        sampleStaleSlugs,
      });
    }

    const unhealthySets = reports.filter((report) => report.unhealthy);
    const payload = {
      ok: unhealthySets.length === 0,
      checkedSets: reports.length,
      freshObservationWindowHours: FRESH_OBSERVATION_WINDOW_HOURS,
      maxSnapshotLagHours: MAX_SNAPSHOT_LAG_HOURS,
      unhealthySetCount: unhealthySets.length,
      unhealthySets,
      reports,
      remediation: unhealthySets.length > 0
        ? "Drain with /api/cron/write-provider-timeseries?provider=SCRYDEX&set=<providerSetId>&observations=3000, then investigate stage budgets."
        : null,
    };

    if (unhealthySets.length > 0) {
      console.error("[check-scrydex-raw-liveness] starvation detected", JSON.stringify({
        unhealthySets: unhealthySets.map((set) => ({
          providerSetId: set.providerSetId,
          staleSnapshots: set.staleSnapshots,
          stalePct: set.stalePct,
          sampleStaleSlugs: set.sampleStaleSlugs,
        })),
      }));
      return NextResponse.json(payload, { status: 500 });
    }

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[check-scrydex-raw-liveness] check failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
