import type { SupabaseClient } from "@supabase/supabase-js";

export type WaitlistTier = "Ace" | "Elite";
export type WaitlistAuthKind = "public" | "user" | "admin" | "cron";

export const WAITLIST_SIGNUP_SOURCE: "pricing_modal";
export const WAITLIST_MIN_PUBLIC_FORM_AGE_MS: number;

export function normalizeWaitlistEmail(value: string): string;
export function isValidWaitlistEmail(value: string): boolean;
export function isValidWaitlistTier(value: unknown): value is WaitlistTier;
export function hashWaitlistLogValue(value: unknown): string | null;
export function parseWaitlistStartedAtMs(value: unknown): number | null;
export function inspectWaitlistBotSignals(input: {
  honeypot?: unknown;
  formStartedAtMs?: unknown;
  nowMs?: number;
  authKind?: WaitlistAuthKind;
}): {
  suspected: boolean;
  reason: "honeypot_filled" | "invalid_form_timestamp" | "submission_too_fast" | null;
  formAgeMs: number | null;
};
export function submitWaitlistSignup(input: {
  supabase: SupabaseClient;
  email: string;
  tier: WaitlistTier;
  clerkUserId?: string | null;
  source?: string;
}): Promise<{ inserted: boolean; outcome: "inserted" | "duplicate_noop" }>;
