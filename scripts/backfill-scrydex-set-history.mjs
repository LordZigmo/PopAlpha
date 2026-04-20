#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import {
  buildCoverageSummary,
  createSupabaseFromEnv,
  loadRetainedPayloads,
  loadSetHistoryCoverage,
} from "./report-scrydex-set-history-coverage.mjs";
import { runScrydexRawNormalize } from "@/lib/backfill/scrydex-raw-normalize";
import { runScrydexNormalizedMatch } from "@/lib/backfill/scrydex-normalized-match";
import { runProviderObservationTimeseries } from "@/lib/backfill/provider-observation-timeseries";
import { runProviderObservationVariantMetrics } from "@/lib/backfill/provider-observation-variant-metrics";
import { refreshPipelineRollupsForVariantKeys } from "@/lib/backfill/provider-pipeline-rollups";

dotenv.config({ path: ".env.local", quiet: true });

const PROVIDER = "SCRYDEX";
const DEFAULT_PAYLOAD_BATCH = 25;
const DEFAULT_MATCH_OBSERVATIONS = 2000;
const DEFAULT_TIMESERIES_OBSERVATIONS = 250;
const DEFAULT_METRICS_OBSERVATIONS = 1000;
const DEFAULT_MAX_STAGE_PASSES = 25;

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseIntArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

function mergeTouchedVariantKeys(...groups) {
  const deduped = new Map();
  for (const group of groups) {
    for (const row of group ?? []) {
      const canonicalSlug = String(row?.canonical_slug ?? "").trim();
      const variantRef = String(row?.variant_ref ?? "").trim();
      const provider = String(row?.provider ?? "").trim().toUpperCase();
      const grade = String(row?.grade ?? "RAW").trim().toUpperCase() || "RAW";
      if (!canonicalSlug || !variantRef || !provider) continue;
      deduped.set(
        `${canonicalSlug}::${variantRef}::${provider}::${grade}`,
        {
          canonical_slug: canonicalSlug,
          variant_ref: variantRef,
          provider,
          grade,
        },
      );
    }
  }
  return [...deduped.values()];
}

async function drainStage(params) {
  const passes = [];
  let touchedVariantKeys = [];

  for (let pass = 1; pass <= params.maxPasses; pass += 1) {
    const result = await params.run();
    passes.push({
      pass,
      ok: result.ok,
      observationsRequested: result.observationsRequested ?? null,
      observationsProcessed: result.observationsProcessed ?? null,
      firstError: result.firstError ?? null,
      touchedVariantKeys: (result.touchedVariantKeys ?? []).length,
    });

    if (!result.ok) {
      throw new Error(`${params.name}: ${result.firstError ?? "stage failed"}`);
    }

    touchedVariantKeys = mergeTouchedVariantKeys(touchedVariantKeys, result.touchedVariantKeys ?? []);

    const requested = Number(result.observationsRequested ?? 0);
    const processed = Number(result.observationsProcessed ?? 0);
    if (!Number.isFinite(processed) || processed <= 0) break;
    if (!Number.isFinite(requested) || processed < requested) break;
  }

  return {
    passes,
    touchedVariantKeys,
  };
}

function summarizeCanonicalDelta(beforeReport, afterReport, canonicalSlug) {
  const before = beforeReport.canonicalCards.find((row) => row.canonicalSlug === canonicalSlug) ?? null;
  const after = afterReport.canonicalCards.find((row) => row.canonicalSlug === canonicalSlug) ?? null;
  return {
    canonicalSlug,
    before,
    after,
  };
}

async function main() {
  const providerSetId = parseStringArg(process.argv, "set", "").trim();
  if (!providerSetId) {
    throw new Error("Usage: node scripts/backfill-scrydex-set-history.mjs --set=<provider_set_id> [--slug=<canonical_slug>] [--payload-batch=<count>] [--match-observations=<count>] [--timeseries-observations=<count>] [--metrics-observations=<count>] [--max-stage-passes=<count>] [--since=<iso>] [--force]");
  }

  const slug = parseStringArg(process.argv, "slug", "").trim() || null;
  const sinceIso = parseStringArg(process.argv, "since", "").trim() || null;
  const payloadBatch = parseIntArg(process.argv, "payload-batch", DEFAULT_PAYLOAD_BATCH);
  const matchObservations = parseIntArg(process.argv, "match-observations", DEFAULT_MATCH_OBSERVATIONS);
  const timeseriesObservations = parseIntArg(process.argv, "timeseries-observations", DEFAULT_TIMESERIES_OBSERVATIONS);
  const metricsObservations = parseIntArg(process.argv, "metrics-observations", DEFAULT_METRICS_OBSERVATIONS);
  const maxStagePasses = parseIntArg(process.argv, "max-stage-passes", DEFAULT_MAX_STAGE_PASSES);
  const force = parseBoolFlag(process.argv, "force");
  const normalizeForce = force;
  const drainForce = false;

  const supabase = createSupabaseFromEnv();
  const beforeReport = await loadSetHistoryCoverage(supabase, { providerSetId, slug, sinceIso });
  const retainedPayloads = await loadRetainedPayloads(supabase, { providerSetId, sinceIso });
  const payloadsToReplay = retainedPayloads.slice(0, payloadBatch);

  if (payloadsToReplay.length === 0) {
    throw new Error(`No retained Scrydex payloads found for ${providerSetId}`);
  }

  const normalizePasses = [];
  for (const payload of payloadsToReplay) {
    const result = await runScrydexRawNormalize({
      rawPayloadId: String(payload.id),
      force: normalizeForce,
    });
    normalizePasses.push({
      rawPayloadId: payload.id,
      fetchedAt: payload.fetched_at,
      ok: result.ok,
      payloadsProcessed: result.payloadsProcessed,
      observationsUpserted: result.observationsUpserted,
      firstError: result.firstError,
    });
    if (!result.ok) {
      throw new Error(`normalize payload ${payload.id}: ${result.firstError ?? "stage failed"}`);
    }
  }

  const matchStage = await drainStage({
    name: "match",
    maxPasses: maxStagePasses,
    run: () => runScrydexNormalizedMatch({
      providerSetId,
      observationLimit: matchObservations,
      force: drainForce,
      mode: "backlog",
      maxRuntimeMs: 240000,
    }),
  });

  const timeseriesStage = await drainStage({
    name: "timeseries",
    maxPasses: maxStagePasses,
    run: () => runProviderObservationTimeseries({
      provider: PROVIDER,
      providerSetId,
      observationLimit: timeseriesObservations,
      force: drainForce,
    }),
  });

  const metricsStage = await drainStage({
    name: "variant_metrics",
    maxPasses: maxStagePasses,
    run: () => runProviderObservationVariantMetrics({
      provider: PROVIDER,
      providerSetId,
      observationLimit: metricsObservations,
      force: drainForce,
    }),
  });

  const touchedVariantKeys = mergeTouchedVariantKeys(
    timeseriesStage.touchedVariantKeys,
    metricsStage.touchedVariantKeys,
  );

  const rollups = touchedVariantKeys.length > 0
    ? await refreshPipelineRollupsForVariantKeys({ keys: touchedVariantKeys })
    : {
      ok: true,
      skipped: true,
      keysRequested: 0,
      keysDeduped: 0,
      canonicalCardsTargeted: 0,
    };

  const afterReport = await loadSetHistoryCoverage(supabase, { providerSetId, slug, sinceIso });

  const payloadRange = {
    oldestFetchedAt: payloadsToReplay[0]?.fetched_at ?? null,
    newestFetchedAt: payloadsToReplay.at(-1)?.fetched_at ?? null,
  };

  const result = {
    ok: true,
    provider: PROVIDER,
    providerSetId,
    slug,
    force,
    generatedAt: new Date().toISOString(),
    retainedPayloadsFound: retainedPayloads.length,
    retainedPayloadsReplayed: payloadsToReplay.length,
    payloadRange,
    before: buildCoverageSummary(beforeReport, 10),
    normalize: {
      passes: normalizePasses,
      observationsUpserted: normalizePasses.reduce((sum, row) => sum + Number(row.observationsUpserted ?? 0), 0),
    },
    match: matchStage,
    timeseries: timeseriesStage,
    variantMetrics: metricsStage,
    rollups,
    after: buildCoverageSummary(afterReport, 10),
    canonicalDelta: slug ? summarizeCanonicalDelta(beforeReport, afterReport, slug) : null,
  };

  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
