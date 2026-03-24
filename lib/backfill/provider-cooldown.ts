import { dbAdmin } from "@/lib/db/admin";
import type { BackendPipelineProvider } from "@/lib/backfill/provider-registry";

const PROVIDER_WIDE_SET_ID = "__provider__";
const DEFAULT_PROVIDER_CREDIT_CAP_COOLDOWN_MINUTES = process.env.PROVIDER_CREDIT_CAP_COOLDOWN_MINUTES
  ? Math.max(60, parseInt(process.env.PROVIDER_CREDIT_CAP_COOLDOWN_MINUTES, 10))
  : 24 * 60;
const SCRYDEX_CREDIT_CAP_COOLDOWN_MINUTES = process.env.SCRYDEX_CREDIT_CAP_COOLDOWN_MINUTES
  ? Math.max(60, parseInt(process.env.SCRYDEX_CREDIT_CAP_COOLDOWN_MINUTES, 10))
  : DEFAULT_PROVIDER_CREDIT_CAP_COOLDOWN_MINUTES;

type ProviderCooldownRow = {
  provider: BackendPipelineProvider;
  provider_set_id: string;
  canonical_set_code: string | null;
  canonical_set_name: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_429_at: string | null;
  last_status_code: number | null;
  consecutive_429: number | null;
  cooldown_until: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  requests_last_run: number | null;
  pages_last_run: number | null;
  cards_last_run: number | null;
  updated_at: string | null;
};

export type ProviderCooldownState = {
  provider: BackendPipelineProvider;
  active: boolean;
  cooldownUntil: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
};

function providerCreditCapCooldownMinutes(provider: BackendPipelineProvider): number {
  if (provider === "SCRYDEX") return SCRYDEX_CREDIT_CAP_COOLDOWN_MINUTES;
  return DEFAULT_PROVIDER_CREDIT_CAP_COOLDOWN_MINUTES;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isProviderCreditCapError(
  provider: BackendPipelineProvider,
  message: string | null | undefined,
): boolean {
  if (provider !== "SCRYDEX") return false;
  const normalized = String(message ?? "").trim().toLowerCase();
  return normalized.includes("credit_cap_hit") || normalized.includes("credit cap enforced");
}

export async function getProviderCooldownState(
  provider: BackendPipelineProvider,
): Promise<ProviderCooldownState> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_set_health")
    .select(
      "provider, provider_set_id, canonical_set_code, canonical_set_name, last_attempt_at, last_success_at, last_429_at, last_status_code, consecutive_429, cooldown_until, next_retry_at, last_error, requests_last_run, pages_last_run, cards_last_run, updated_at",
    )
    .eq("provider", provider)
    .eq("provider_set_id", PROVIDER_WIDE_SET_ID)
    .maybeSingle<ProviderCooldownRow>();

  if (error) throw new Error(`provider_set_health(provider cooldown): ${error.message}`);

  const cooldownUntil = data?.cooldown_until ?? null;
  const cooldownUntilMs = toMs(cooldownUntil);
  return {
    provider,
    active: cooldownUntilMs !== null && cooldownUntilMs > Date.now(),
    cooldownUntil,
    lastStatusCode: data?.last_status_code ?? null,
    lastError: data?.last_error ?? null,
  };
}

export async function markProviderCreditCapCooldown(input: {
  provider: BackendPipelineProvider;
  statusCode?: number | null;
  errorMessage: string;
  canonicalSetCode?: string | null;
  canonicalSetName?: string | null;
}): Promise<ProviderCooldownState> {
  const supabase = dbAdmin();
  const existing = await getProviderCooldownState(input.provider);
  const nowIso = new Date().toISOString();
  const cooldownUntil = new Date(
    Date.now() + providerCreditCapCooldownMinutes(input.provider) * 60 * 1000,
  ).toISOString();

  const { error } = await supabase
    .from("provider_set_health")
    .upsert({
      provider: input.provider,
      provider_set_id: PROVIDER_WIDE_SET_ID,
      canonical_set_code: input.canonicalSetCode ?? PROVIDER_WIDE_SET_ID,
      canonical_set_name: input.canonicalSetName ?? `${input.provider} provider cooldown`,
      last_attempt_at: nowIso,
      last_success_at: null,
      last_429_at: input.statusCode === 429 ? nowIso : null,
      last_status_code: input.statusCode ?? 403,
      consecutive_429: input.statusCode === 429 ? 1 : 0,
      cooldown_until: cooldownUntil,
      next_retry_at: cooldownUntil,
      last_error: input.errorMessage,
      requests_last_run: 0,
      pages_last_run: 0,
      cards_last_run: 0,
      updated_at: nowIso,
    }, { onConflict: "provider,provider_set_id" });

  if (error) throw new Error(`provider_set_health(provider cooldown upsert): ${error.message}`);

  return {
    provider: input.provider,
    active: true,
    cooldownUntil,
    lastStatusCode: input.statusCode ?? 403,
    lastError: input.errorMessage || existing.lastError,
  };
}
