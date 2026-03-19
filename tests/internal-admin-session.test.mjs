import assert from "node:assert/strict";
import {
  INTERNAL_ADMIN_DEFAULT_RETURN_TO,
  buildInternalAdminActorIdentifier,
  buildTrustedInternalAdminOperator,
  createInternalAdminSessionToken,
  evaluateInternalAdminAccess,
  hasConfiguredInternalAdminAllowlist,
  isTrustedInternalAdminOperator,
  normalizeInternalAdminActorIdentifier,
  resolveInternalAdminAllowlist,
  resolveInternalAdminSessionSigningSecret,
  sanitizeInternalAdminReturnTo,
  verifyInternalAdminSessionToken,
} from "../lib/auth/internal-admin-session-core.ts";

export function runInternalAdminSessionTests() {
  const operator = buildTrustedInternalAdminOperator({
    clerkUserId: "user_123",
    primaryEmail: "Alice@Example.com",
    displayName: "Alice Admin",
  });
  assert.equal(operator.clerkUserId, "user_123");
  assert.equal(operator.primaryEmail, "alice@example.com");
  assert.equal(operator.displayName, "Alice Admin");
  assert.equal(operator.actorIdentifier, "clerk:user_123");
  assert.equal(buildInternalAdminActorIdentifier("user_123"), "clerk:user_123");
  assert.equal(normalizeInternalAdminActorIdentifier("clerk:user_123"), "clerk:user_123");
  assert.equal(normalizeInternalAdminActorIdentifier("clerk: user_123"), null);
  assert.equal(normalizeInternalAdminActorIdentifier("alice@example.com"), null);

  const token = createInternalAdminSessionToken({
    operator,
    secret: "internal-admin-secret",
    now: 1_000,
    ttlMs: 5_000,
  });

  const verified = verifyInternalAdminSessionToken(token, { secret: "internal-admin-secret", now: 2_000 });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.session.clerkUserId, "user_123");
    assert.equal(verified.session.actorIdentifier, "clerk:user_123");
    assert.equal(verified.session.primaryEmail, "alice@example.com");
    assert.equal(verified.session.displayName, "Alice Admin");
    assert.equal(verified.session.issuedAtMs, 1_000);
    assert.equal(verified.session.expiresAtMs, 6_000);
  }

  const tampered = verifyInternalAdminSessionToken(`${token}x`, {
    secret: "internal-admin-secret",
    now: 2_000,
  });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) {
    assert.equal(tampered.code, "bad_signature");
  }

  const expired = verifyInternalAdminSessionToken(token, { secret: "internal-admin-secret", now: 6_001 });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.code, "expired");
  }

  assert.equal(
    sanitizeInternalAdminReturnTo("/internal/admin/ebay-deletion-tasks?reviewState=pending_review"),
    "/internal/admin/ebay-deletion-tasks?reviewState=pending_review",
  );
  assert.equal(
    sanitizeInternalAdminReturnTo("https://evil.example/internal/admin/ebay-deletion-tasks"),
    INTERNAL_ADMIN_DEFAULT_RETURN_TO,
  );
  assert.equal(
    sanitizeInternalAdminReturnTo("/internal/admin/sign-in?returnTo=/internal/admin/ebay-deletion-tasks"),
    INTERNAL_ADMIN_DEFAULT_RETURN_TO,
  );

  const allowlist = resolveInternalAdminAllowlist({
    INTERNAL_ADMIN_CLERK_USER_IDS: "user_123, user_456",
    INTERNAL_ADMIN_EMAILS: "ops@example.com, alice@example.com",
  });
  assert.equal(hasConfiguredInternalAdminAllowlist(allowlist), true);
  assert.equal(allowlist.clerkUserIds.has("user_123"), true);
  assert.equal(allowlist.emails.has("alice@example.com"), true);
  assert.equal(isTrustedInternalAdminOperator(operator, allowlist), true);

  const emailOnlyOperator = buildTrustedInternalAdminOperator({
    clerkUserId: "user_999",
    primaryEmail: "ops@example.com",
    displayName: "Ops User",
  });
  assert.equal(isTrustedInternalAdminOperator(emailOnlyOperator, allowlist), true);

  const unauthorizedOperator = buildTrustedInternalAdminOperator({
    clerkUserId: "user_777",
    primaryEmail: "user@example.com",
    displayName: "Regular User",
  });
  assert.equal(isTrustedInternalAdminOperator(unauthorizedOperator, allowlist), false);

  assert.deepEqual(
    evaluateInternalAdminAccess({
      clerkEnabled: true,
      operator: null,
      allowlist,
    }),
    { kind: "unauthenticated" },
  );
  assert.equal(
    evaluateInternalAdminAccess({
      clerkEnabled: true,
      operator,
      allowlist,
    }).kind,
    "authorized",
  );
  assert.equal(
    evaluateInternalAdminAccess({
      clerkEnabled: true,
      operator: unauthorizedOperator,
      allowlist,
    }).kind,
    "forbidden",
  );
  assert.deepEqual(
    evaluateInternalAdminAccess({
      clerkEnabled: true,
      operator,
      allowlist: resolveInternalAdminAllowlist({}),
    }),
    { kind: "misconfigured", reason: "missing_allowlist" },
  );
  assert.deepEqual(
    evaluateInternalAdminAccess({
      clerkEnabled: false,
      operator,
      allowlist,
    }),
    { kind: "misconfigured", reason: "clerk_unavailable" },
  );

  assert.equal(
    resolveInternalAdminSessionSigningSecret({
      INTERNAL_ADMIN_SESSION_SECRET: "explicit-signing-secret",
      ADMIN_SECRET: "fallback-admin-secret",
    }),
    "explicit-signing-secret",
  );
  assert.equal(
    resolveInternalAdminSessionSigningSecret({ ADMIN_SECRET: "fallback-admin-secret" }),
    "fallback-admin-secret",
  );
  assert.throws(
    () => resolveInternalAdminSessionSigningSecret({}),
    /INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET/,
  );
}
