/**
 * Single source of truth for backend pipeline providers.
 *
 * As of 2026-04-17 only SCRYDEX is active. JUSTTCG, POKETRACE, and
 * POKEMON_TCG_API have been retired. Historical rows in pricing tables
 * still carry those provider strings and are read by SQL rollups, but no
 * code path writes them anymore.
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
