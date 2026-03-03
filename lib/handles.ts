/**
 * Handle validation — pure functions, no server imports.
 * Shared by client components and server API routes.
 */

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const DOUBLE_UNDERSCORE = /__/;

const RESERVED = new Set([
  "admin",
  "api",
  "cron",
  "debug",
  "help",
  "login",
  "logout",
  "me",
  "mod",
  "moderator",
  "null",
  "onboarding",
  "popalpha",
  "portfolio",
  "root",
  "search",
  "settings",
  "sign-in",
  "signin",
  "sign-up",
  "signup",
  "support",
  "system",
  "test",
  "undefined",
  "user",
]);

export type HandleValid = { valid: true; normalized: string };
export type HandleInvalid = { valid: false; reason: string };
export type HandleResult = HandleValid | HandleInvalid;

export function validateHandle(raw: string): HandleResult {
  const normalized = raw.trim().toLowerCase();

  if (normalized.length < 3) {
    return { valid: false, reason: "Handle must be at least 3 characters." };
  }
  if (normalized.length > 20) {
    return { valid: false, reason: "Handle must be 20 characters or fewer." };
  }
  if (!HANDLE_RE.test(normalized)) {
    return { valid: false, reason: "Only lowercase letters, numbers, and underscores allowed." };
  }
  if (normalized.startsWith("_") || normalized.endsWith("_")) {
    return { valid: false, reason: "Handle cannot start or end with an underscore." };
  }
  if (DOUBLE_UNDERSCORE.test(normalized)) {
    return { valid: false, reason: "Handle cannot contain consecutive underscores." };
  }
  if (RESERVED.has(normalized)) {
    return { valid: false, reason: "That handle is reserved." };
  }

  return { valid: true, normalized };
}

/**
 * Validate a return_to parameter — must be an internal path.
 * Returns "/" if invalid.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return "/";
  if (trimmed.includes("://")) return "/";
  return trimmed;
}
