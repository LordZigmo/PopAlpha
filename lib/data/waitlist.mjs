import { hashPublicWriteValue } from "../public-write.mjs";

export const WAITLIST_SIGNUP_SOURCE = "pricing_modal";
export const WAITLIST_MIN_PUBLIC_FORM_AGE_MS = 1_200;
const WAITLIST_MAX_STARTED_AT_FUTURE_SKEW_MS = 10_000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeWaitlistEmail(value) {
  return normalizeText(value).toLowerCase();
}

export function isValidWaitlistEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeText(value));
}

export function isValidWaitlistTier(value) {
  return value === "Ace" || value === "Elite";
}

export function hashWaitlistLogValue(value) {
  return hashPublicWriteValue(value);
}

export function parseWaitlistStartedAtMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

export function inspectWaitlistBotSignals({
  honeypot,
  formStartedAtMs,
  nowMs = Date.now(),
  authKind = "public",
}) {
  const startedAtMs = parseWaitlistStartedAtMs(formStartedAtMs);
  const formAgeMs = startedAtMs == null ? null : nowMs - startedAtMs;

  if (normalizeText(honeypot)) {
    return {
      suspected: true,
      reason: "honeypot_filled",
      formAgeMs,
    };
  }

  if (authKind !== "user" && startedAtMs != null) {
    if (formAgeMs != null && formAgeMs < -WAITLIST_MAX_STARTED_AT_FUTURE_SKEW_MS) {
      return {
        suspected: true,
        reason: "invalid_form_timestamp",
        formAgeMs,
      };
    }

    if (formAgeMs != null && formAgeMs >= 0 && formAgeMs < WAITLIST_MIN_PUBLIC_FORM_AGE_MS) {
      return {
        suspected: true,
        reason: "submission_too_fast",
        formAgeMs,
      };
    }
  }

  return {
    suspected: false,
    reason: null,
    formAgeMs,
  };
}

/**
 * Waitlist signups stay insert-only for public callers.
 * Duplicate submissions are accepted as a no-op so the public route remains
 * idempotent without widening the table contract to SELECT or UPDATE.
 */
export async function submitWaitlistSignup({
  supabase,
  email,
  tier,
  clerkUserId = null,
  source = WAITLIST_SIGNUP_SOURCE,
}) {
  const { error } = await supabase
    .from("waitlist_signups")
    .insert({
      email: normalizeText(email),
      email_normalized: normalizeWaitlistEmail(email),
      desired_tier: tier,
      source,
      clerk_user_id: clerkUserId,
    });

  if (!error) {
    return { inserted: true, outcome: "inserted" };
  }

  if (error.code === "23505") {
    return { inserted: false, outcome: "duplicate_noop" };
  }

  throw error;
}
