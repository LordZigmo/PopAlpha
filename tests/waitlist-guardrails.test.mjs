import assert from "node:assert/strict";
import {
  hashWaitlistLogValue,
  inspectWaitlistBotSignals,
  normalizeWaitlistEmail,
  WAITLIST_MIN_PUBLIC_FORM_AGE_MS,
} from "../lib/data/waitlist.mjs";

export function runWaitlistGuardrailTests() {
  const nowMs = 1_750_000_000_000;
  const normalizedEmail = normalizeWaitlistEmail("Collector@Example.com ");

  assert.equal(normalizedEmail, "collector@example.com");
  assert.equal(hashWaitlistLogValue(normalizedEmail)?.length, 16);

  const matureAnonSubmission = inspectWaitlistBotSignals({
    honeypot: "",
    formStartedAtMs: nowMs - WAITLIST_MIN_PUBLIC_FORM_AGE_MS - 25,
    nowMs,
    authKind: "public",
  });
  assert.equal(matureAnonSubmission.suspected, false);
  assert.equal(matureAnonSubmission.reason, null);
  assert.equal(matureAnonSubmission.formAgeMs, WAITLIST_MIN_PUBLIC_FORM_AGE_MS + 25);

  const fastAnonSubmission = inspectWaitlistBotSignals({
    honeypot: "",
    formStartedAtMs: nowMs - WAITLIST_MIN_PUBLIC_FORM_AGE_MS + 100,
    nowMs,
    authKind: "public",
  });
  assert.equal(fastAnonSubmission.suspected, true);
  assert.equal(fastAnonSubmission.reason, "submission_too_fast");

  const honeypotSubmission = inspectWaitlistBotSignals({
    honeypot: "https://spam.example",
    formStartedAtMs: nowMs - 5_000,
    nowMs,
    authKind: "public",
  });
  assert.equal(honeypotSubmission.suspected, true);
  assert.equal(honeypotSubmission.reason, "honeypot_filled");
  assert.equal(honeypotSubmission.formAgeMs, 5_000);

  const authenticatedFastSubmission = inspectWaitlistBotSignals({
    honeypot: "",
    formStartedAtMs: nowMs - 100,
    nowMs,
    authKind: "user",
  });
  assert.equal(authenticatedFastSubmission.suspected, false);
  assert.equal(authenticatedFastSubmission.reason, null);

  const missingTimestamp = inspectWaitlistBotSignals({
    honeypot: "",
    formStartedAtMs: null,
    nowMs,
    authKind: "public",
  });
  assert.equal(missingTimestamp.suspected, false);
  assert.equal(missingTimestamp.formAgeMs, null);
}
