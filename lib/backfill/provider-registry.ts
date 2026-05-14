/**
 * Single source of truth for backend pipeline providers.
 *
 * As of 2026-04-17 only SCRYDEX is in the queue-driven pipeline.
 * JUSTTCG, POKETRACE, and POKEMON_TCG_API have been retired. Historical
 * rows in pricing tables still carry those provider strings and are
 * read by SQL rollups, but no code path writes them anymore.
 *
 * YAHOO_JP intentionally does NOT live in this registry. It runs
 * outside the pipeline_jobs queue (cron route at
 * /api/cron/run-yahoo-jp-daily + standalone backfill at
 * scripts/run-yahoo-jp-pipeline.mjs) because:
 *   • Yahoo! listings don't have stable provider_card_ids that map to
 *     canonical_slug; matching is structural via title parsing in
 *     lib/jp/matcher.mjs, not via provider_card_map lookup.
 *   • The raw → normalized → matched → variant_metrics → card_metrics
 *     rollup path assumes provider_card_id indirection. Forcing
 *     YAHOO_JP through it would either need fake provider IDs or a
 *     parallel matcher that duplicates lib/jp/matcher.mjs.
 *   • YAHOO_JP writes directly to its own table (yahoo_jp_card_prices),
 *     joined into public_card_metrics via a view. Different table,
 *     different lifecycle, different code path — not a queue tenant.
 *
 * The "YAHOO_JP" string still appears in `provider_normalized_observations`
 * and a few comments/labels for human-readable provenance, but those
 * sites don't read this registry.
 *
 * Note: the active Scrydex ingest/normalize/match lib lives in
 * `lib/backfill/pokemontcg-*.ts` for historical reasons — the Scrydex
 * pipeline was built on top of the original pokemontcg scaffolding and
 * piggybacks on the same module.
 */

export const BACKEND_PIPELINE_PROVIDERS = [
  "SCRYDEX",
] as const;

export type BackendPipelineProvider = typeof BACKEND_PIPELINE_PROVIDERS[number];

export const ANALYTICS_PIPELINE_PROVIDERS = [
  "SCRYDEX",
] as const;

export type AnalyticsPipelineProvider = typeof ANALYTICS_PIPELINE_PROVIDERS[number];

export type ProviderPipelineCapabilities = {
  provider: BackendPipelineProvider;
  source: string;
  supportsAnalytics: boolean;
  supportsRetry: boolean;
  ingestionEnabled: boolean;
  ingestionDisabledReason: string | null;
};

export const PROVIDER_PIPELINE_CAPABILITIES: Record<BackendPipelineProvider, ProviderPipelineCapabilities> = {
  SCRYDEX: {
    provider: "SCRYDEX",
    source: "scrydex",
    supportsAnalytics: true,
    supportsRetry: true,
    ingestionEnabled: true,
    ingestionDisabledReason: null,
  },
};

export function isBackendPipelineProvider(value: string | null | undefined): value is BackendPipelineProvider {
  const normalized = String(value ?? "").trim().toUpperCase();
  return BACKEND_PIPELINE_PROVIDERS.includes(normalized as BackendPipelineProvider);
}

export function isAnalyticsPipelineProvider(value: string | null | undefined): value is AnalyticsPipelineProvider {
  const normalized = String(value ?? "").trim().toUpperCase();
  return ANALYTICS_PIPELINE_PROVIDERS.includes(normalized as AnalyticsPipelineProvider);
}

export function providerSupportsAnalytics(provider: BackendPipelineProvider): provider is AnalyticsPipelineProvider {
  return PROVIDER_PIPELINE_CAPABILITIES[provider].supportsAnalytics;
}

export function providerIngestionEnabled(provider: BackendPipelineProvider): boolean {
  return PROVIDER_PIPELINE_CAPABILITIES[provider].ingestionEnabled;
}

export function providerIngestionDisabledReason(provider: BackendPipelineProvider): string {
  return PROVIDER_PIPELINE_CAPABILITIES[provider].ingestionDisabledReason ?? "provider_ingestion_disabled";
}

export function buildProviderIngestionDisabledPayload(provider: BackendPipelineProvider): {
  ok: true;
  provider: BackendPipelineProvider;
  retired: true;
  preservedDataAvailable: true;
  reason: string;
} {
  return {
    ok: true,
    provider,
    retired: true,
    preservedDataAvailable: true,
    reason: providerIngestionDisabledReason(provider),
  };
}
