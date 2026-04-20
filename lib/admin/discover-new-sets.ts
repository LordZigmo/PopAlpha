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

const PROVIDER = "SCRYDEX";
const JOB = "discover_new_sets";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SET = 10;

export type DiscoverNewSetsParams = {
  force?: boolean;
};

export type DiscoverNewSetsResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  totalCount?: number;
  lastKnownTotalCount?: number | null;
  newSetIds?: string[];
  seededSetIds?: string[];
  failedSetIds?: Array<{ id: string; error: string }>;
  runId?: string;
  elapsedMs?: number;
  error?: string;
};

type LastDiscoverMeta = {
  expansionsTotalCount?: number;
};

type LastDiscoverRow = {
  meta: LastDiscoverMeta | null;
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

  if (!params.force && lastKnownTotalCount !== null && probedTotalCount === lastKnownTotalCount) {
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
    const newSetIds = newExpansions.map((exp) => exp.id);

    const seededSetIds: string[] = [];
    const failedSetIds: Array<{ id: string; error: string }> = [];

    for (const exp of newExpansions) {
      const importResult = await runScrydexCanonicalImport({
        pageStart: 1,
        maxPages: MAX_PAGES_PER_SET,
        pageSize: PAGE_SIZE,
        expansionId: exp.id,
        dryRun: false,
        provisional: true,
      });

      if (importResult.status >= 200 && importResult.status < 300 && importResult.body.ok) {
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
        } else {
          seededSetIds.push(exp.id);
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
          seededSetIds,
          failedSetIds,
        },
      })
      .eq("id", runId);

    return {
      ok: failedSetIds.length === 0,
      totalCount,
      lastKnownTotalCount,
      newSetIds,
      seededSetIds,
      failedSetIds,
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
