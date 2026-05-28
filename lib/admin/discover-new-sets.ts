/**
 * Discover brand-new Pokemon sets from Scrydex and provisionally seed them.
 *
 * Cheap mode (default): probe the expansions endpoint with pageSize=1 to read
 * totalCount. Compare to the last known value stored in ingest_runs.meta. If
 * unchanged, exit (1 Scrydex credit used). Only when totalCount has grown do
 * we fetch the full list, diff against provider_set_map, and seed the new set.
 *
 * Force mode: skip the probe and always do the full diff + seed. Used by the
 * admin on-demand trigger.
 *
 * Safety: only acts on expansions that have NO existing provider_set_map row
 * for provider='SCRYDEX'. Never touches existing canonical data. Seeded rows
 * carry source='scrydex_provisional' so a later pokemon-tcg-data import can
 * reconcile.
 */

import { dbAdmin } from "@/lib/db/admin";
import {
  fetchExpansionsPage,
  getScrydexCredentials,
  type ScrydexExpansion,
} from "@/lib/scrydex/client";
import { runScrydexCanonicalImport } from "@/lib/admin/scrydex-canonical-import";
import { enqueuePipelineJob } from "@/lib/backfill/provider-pipeline-job-queue";

const PROVIDER = "SCRYDEX";
const JOB = "discover_new_sets";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SET = 10;

export type DiscoverNewSetsParams = {
  force?: boolean;
};

export type DiscoverNewSetsBootstrapJob = {
  providerSetId: string;
  enqueued: boolean;
  jobId: number | null;
  reason: string;
};

export type DiscoverNewSetsResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  totalCount?: number;
  lastKnownTotalCount?: number | null;
  newSetIds?: string[];
  repairSetIds?: string[];
  seededSetIds?: string[];
  repairedSetIds?: string[];
  filteredSetIds?: Array<{ id: string; reason: string }>;
  failedSetIds?: Array<{ id: string; error: string }>;
  bootstrapJobs?: DiscoverNewSetsBootstrapJob[];
  runId?: string;
  elapsedMs?: number;
  error?: string;
};

// Only physical, first-party releases are worth auto-seeding. Everything else
// (TCG Pocket digital sets, Scrydex's "Other" catch-all bucket, etc.) should
// be skipped at discovery so we don't waste credits importing cards that
// aren't part of the collectible catalog.
function filterReason(exp: ScrydexExpansion): string | null {
  if (exp.is_online_only === true) return "online_only";
  if (typeof exp.series === "string" && exp.series.trim().toLowerCase() === "other") return "series_other";
  return null;
}

type LastDiscoverMeta = {
  expansionsTotalCount?: number;
};

type LastDiscoverRow = {
  meta: LastDiscoverMeta | null;
};

type MappedSetRow = {
  provider_set_id: string | null;
  canonical_set_name: string | null;
  last_verified_at: string | null;
};

type RepairCandidate = {
  id: string;
  name: string | null;
};

async function fetchAllExpansions(credentials: ReturnType<typeof getScrydexCredentials>): Promise<{
  expansions: ScrydexExpansion[];
  totalCount: number;
}> {
  const all: ScrydexExpansion[] = [];
  let page = 1;
  let totalCount = 0;
  while (true) {
    const res = await fetchExpansionsPage(page, PAGE_SIZE, credentials);
    totalCount = res.totalCount;
    all.push(...res.data);
    if (res.data.length < PAGE_SIZE) break;
    if (all.length >= totalCount) break;
    page += 1;
  }
  return { expansions: all, totalCount };
}

async function loadRecentMappedSetsMissingPrintings(
  supabase: ReturnType<typeof dbAdmin>,
): Promise<RepairCandidate[]> {
  const recentCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const { data: mappedRows, error: mappedError } = await supabase
    .from("provider_set_map")
    .select("provider_set_id, canonical_set_name, last_verified_at")
    .eq("provider", PROVIDER)
    .not("provider_set_id", "is", null)
    .gte("last_verified_at", recentCutoff)
    .order("last_verified_at", { ascending: false })
    .limit(20);

  if (mappedError) throw new Error(`provider_set_map(repair scan): ${mappedError.message}`);

  const candidates = ((mappedRows ?? []) as MappedSetRow[])
    .map((row) => ({
      id: String(row.provider_set_id ?? "").trim(),
      name: row.canonical_set_name?.trim() || null,
    }))
    .filter((row) => row.id.length > 0);

  if (candidates.length === 0) return [];

  const { data: printingRows, error: printingError } = await supabase
    .from("card_printings")
    .select("set_code")
    .in("set_code", candidates.map((row) => row.id));

  if (printingError) throw new Error(`card_printings(repair scan): ${printingError.message}`);

  const setCodesWithPrintings = new Set(
    ((printingRows ?? []) as Array<{ set_code: string | null }>)
      .map((row) => String(row.set_code ?? "").trim())
      .filter(Boolean),
  );

  return candidates.filter((row) => !setCodesWithPrintings.has(row.id));
}

export async function runDiscoverNewSets(
  params: DiscoverNewSetsParams = {},
): Promise<DiscoverNewSetsResult> {
  const startedAt = Date.now();

  let credentials: ReturnType<typeof getScrydexCredentials>;
  try {
    credentials = getScrydexCredentials();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const supabase = dbAdmin();

  // ── Probe: cheap totalCount check ───────────────────────────────────────
  let probedTotalCount: number;
  try {
    const probe = await fetchExpansionsPage(1, 1, credentials);
    probedTotalCount = probe.totalCount;
  } catch (error) {
    return {
      ok: false,
      error: `Scrydex probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const { data: lastRun } = await supabase
    .from("ingest_runs")
    .select("meta")
    .eq("job", JOB)
    .eq("ok", true)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle<LastDiscoverRow>();

  const lastKnownTotalCount =
    typeof lastRun?.meta?.expansionsTotalCount === "number"
      ? lastRun.meta.expansionsTotalCount
      : null;

  let repairCandidates: RepairCandidate[] = [];
  try {
    repairCandidates = await loadRecentMappedSetsMissingPrintings(supabase);
  } catch (error) {
    return {
      ok: false,
      error: `New-set repair scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (
    !params.force
    && lastKnownTotalCount !== null
    && probedTotalCount === lastKnownTotalCount
    && repairCandidates.length === 0
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "unchanged",
      totalCount: probedTotalCount,
      lastKnownTotalCount,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── Open an ingest_runs record for this discovery pass ──────────────────
  const { data: runRow, error: runError } = await supabase
    .from("ingest_runs")
    .insert({
      source: "scrydex",
      job: JOB,
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: {
        force: Boolean(params.force),
        probedTotalCount,
        lastKnownTotalCount,
      },
    })
    .select("id")
    .single<{ id: string }>();

  if (runError || !runRow) {
    return {
      ok: false,
      error: runError?.message ?? "Could not create ingest run.",
    };
  }

  const runId = runRow.id;

  try {
    const { expansions, totalCount } = await fetchAllExpansions(credentials);

    const { data: mapped, error: mappedError } = await supabase
      .from("provider_set_map")
      .select("provider_set_id")
      .eq("provider", PROVIDER);

    if (mappedError) throw new Error(mappedError.message);

    const knownIds = new Set((mapped ?? []).map((row) => String(row.provider_set_id)));
    const newExpansions = expansions.filter((exp) => !knownIds.has(exp.id));

    const filteredSetIds: Array<{ id: string; reason: string }> = [];
    const seedableExpansions: ScrydexExpansion[] = [];
    for (const exp of newExpansions) {
      const skipReason = filterReason(exp);
      if (skipReason) {
        filteredSetIds.push({ id: exp.id, reason: skipReason });
      } else {
        seedableExpansions.push(exp);
      }
    }
    const newSetIds = seedableExpansions.map((exp) => exp.id);

    const seededSetIds: string[] = [];
    const repairedSetIds: string[] = [];
    const failedSetIds: Array<{ id: string; error: string }> = [];
    const bootstrapJobs: DiscoverNewSetsBootstrapJob[] = [];

    const repairIds = new Set(repairCandidates.map((candidate) => candidate.id));
    const importTargets = [
      ...seedableExpansions.map((exp) => ({ exp, kind: "new" as const })),
      ...repairCandidates
        .filter((candidate) => !seedableExpansions.some((exp) => exp.id === candidate.id))
        .map((candidate) => ({
          exp: {
            id: candidate.id,
            name: candidate.name ?? candidate.id,
          } as ScrydexExpansion,
          kind: "repair" as const,
        })),
    ];

    for (const { exp, kind } of importTargets) {
      const importResult = await runScrydexCanonicalImport({
        pageStart: 1,
        maxPages: MAX_PAGES_PER_SET,
        pageSize: PAGE_SIZE,
        expansionId: exp.id,
        dryRun: false,
        provisional: true,
      });

      if (importResult.status >= 200 && importResult.status < 300 && importResult.body.ok) {
        if (kind === "new") {
          const { error: mapInsertError } = await supabase
            .from("provider_set_map")
            .upsert(
              {
                provider: PROVIDER,
                canonical_set_code: exp.id,
                canonical_set_name: exp.name,
                provider_set_id: exp.id,
                confidence: 0.9,
                last_verified_at: new Date().toISOString(),
              },
              { onConflict: "provider,canonical_set_code" },
            );

          if (mapInsertError) {
            failedSetIds.push({ id: exp.id, error: `provider_set_map: ${mapInsertError.message}` });
            continue;
          }
          seededSetIds.push(exp.id);
        } else {
          repairedSetIds.push(exp.id);
        }

        // Bootstrap a one-shot pipeline job so the daily-capture planner's
        // matchedCardCount > 0 gate can let this set into normal rotation.
        // Without this enqueue, a freshly-seeded provisional set sits in
        // canonical_cards forever — observable in the 2026-04-20 Perfect
        // Order incident where 124 canonical rows had zero priced
        // observations weeks later. The same enqueue repairs recent mapped
        // sets whose earlier import created canonical rows but failed before
        // card_printings were available for matching.
        try {
          const enqueue = await enqueuePipelineJob({
            provider: PROVIDER,
            jobKind: "PIPELINE",
            params: { providerSetId: exp.id },
          });
          bootstrapJobs.push({
            providerSetId: exp.id,
            enqueued: enqueue.enqueued,
            jobId: enqueue.jobId,
            reason: enqueue.reason,
          });
        } catch (enqueueError) {
          const message = enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError);
          bootstrapJobs.push({
            providerSetId: exp.id,
            enqueued: false,
            jobId: null,
            reason: `enqueue_error: ${message}`,
          });
        }
      } else {
        const errMsg = typeof importResult.body.error === "string"
          ? importResult.body.error
          : `canonical import status=${importResult.status}`;
        failedSetIds.push({ id: exp.id, error: errMsg });
      }
    }

    const finishedAt = new Date().toISOString();
    await supabase
      .from("ingest_runs")
      .update({
        status: "finished",
        ok: failedSetIds.length === 0,
        items_fetched: expansions.length,
        items_upserted: seededSetIds.length,
        items_failed: failedSetIds.length,
        ended_at: finishedAt,
        meta: {
          force: Boolean(params.force),
          probedTotalCount,
          lastKnownTotalCount,
          expansionsTotalCount: totalCount,
          newSetIds,
          repairSetIds: [...repairIds],
          seededSetIds,
          repairedSetIds,
          filteredSetIds,
          failedSetIds,
          bootstrapJobs,
        },
      })
      .eq("id", runId);

    return {
      ok: failedSetIds.length === 0,
      totalCount,
      lastKnownTotalCount,
      newSetIds,
      repairSetIds: [...repairIds],
      seededSetIds,
      repairedSetIds,
      filteredSetIds,
      failedSetIds,
      bootstrapJobs,
      runId,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("ingest_runs")
      .update({
        status: "failed",
        ok: false,
        error_text: message,
        ended_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return {
      ok: false,
      error: message,
      runId,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
