export const BACKEND_PIPELINE_PROVIDERS = [
  "JUSTTCG",
  "SCRYDEX",
  "POKETRACE",
] as const;

export type BackendPipelineProvider = typeof BACKEND_PIPELINE_PROVIDERS[number];

export const ANALYTICS_PIPELINE_PROVIDERS = [
  "JUSTTCG",
  "SCRYDEX",
] as const;

export type AnalyticsPipelineProvider = typeof ANALYTICS_PIPELINE_PROVIDERS[number];

export type ProviderPipelineCapabilities = {
  provider: BackendPipelineProvider;
  source: string;
  supportsAnalytics: boolean;
  supportsRetry: boolean;
};

export const PROVIDER_PIPELINE_CAPABILITIES: Record<BackendPipelineProvider, ProviderPipelineCapabilities> = {
  JUSTTCG: {
    provider: "JUSTTCG",
    source: "justtcg",
    supportsAnalytics: true,
    supportsRetry: true,
  },
  SCRYDEX: {
    provider: "SCRYDEX",
    source: "scrydex",
    supportsAnalytics: true,
    supportsRetry: true,
  },
  POKETRACE: {
    provider: "POKETRACE",
    source: "poketrace",
    supportsAnalytics: false,
    supportsRetry: true,
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
