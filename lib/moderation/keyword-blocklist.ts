/**
 * Server-side keyword blocklist for user-generated text.
 *
 * Apple Guideline 1.2 requires automated content filtering on UGC.
 * This is the cheapest, highest-precision filter: a small list of
 * unambiguous slurs and spam strings that should never appear in a
 * collector-app comment. False positives are vanishingly rare.
 *
 * Stronger toxicity classification (e.g., a hosted moderation API) is a
 * follow-up; the bar Apple checks is "automated filtering exists" — this
 * file satisfies that, and the operator-driven moderation_reports queue
 * + soft-hide flag (activity_comments.hidden_at) handles edge cases.
 *
 * NOTE: Anything matched here is REJECTED at write time. Operators can
 * also retroactively hide items via moderation_reports review.
 */

const SLURS = [
  // Common English slurs covering the categories Apple specifically calls out
  // (race, sexual orientation, gender identity, disability). Kept short and
  // unambiguous — no soft/contextual terms. Stored as lowercase, matched
  // word-boundary case-insensitive against the trimmed body.
  "n1gger",
  "nigger",
  "n1gga",
  "nigga",
  "f4ggot",
  "faggot",
  "f4g",
  "tranny",
  "retard",
  "retarded",
  "kike",
  "spic",
  "chink",
  "gook",
  "wetback",
  "coon",
];

const SPAM_PATTERNS = [
  // Obvious commerce-spam patterns; collector app doesn't need links to
  // external marketplaces in comments.
  /\bhttps?:\/\/(?!popalpha\.ai)[^\s]+/i,
  /\bbit\.ly\/[a-z0-9]+/i,
  /\btelegram\.me\/[a-z0-9]+/i,
  /\bwhatsapp\.com\/[a-z0-9]+/i,
  /\b(?:viagra|cialis)\b/i,
  /\bcrypto\s*pump/i,
];

/**
 * Returns null if the body is acceptable, or a short reason string if it
 * matches the blocklist. Reason is intentionally generic — we don't tell
 * the user *which* word tripped it, to avoid teaching evasion.
 */
export function validateUserContent(rawBody: string): { ok: true } | { ok: false; reason: string } {
  const body = rawBody.toLowerCase();

  for (const slur of SLURS) {
    const re = new RegExp(`\\b${slur.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(body)) {
      return { ok: false, reason: "Comment violates community guidelines." };
    }
  }

  for (const re of SPAM_PATTERNS) {
    if (re.test(body)) {
      return { ok: false, reason: "Links and promotional content aren't allowed in comments." };
    }
  }

  return { ok: true };
}
