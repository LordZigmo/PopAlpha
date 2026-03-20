import assert from "node:assert/strict";
import { ADMIN_ROUTES, CRON_ROUTES } from "../lib/auth/route-registry.ts";
import { INTERNAL_ROUTE_TRUST_CONTRACTS } from "../scripts/security-guardrails.config.mjs";

export function runInternalRouteTrustTests() {
  const adminRoutes = new Set(ADMIN_ROUTES);
  const cronRoutes = new Set(CRON_ROUTES);
  const classifiedRoutes = new Set(Object.keys(INTERNAL_ROUTE_TRUST_CONTRACTS));

  for (const routeKey of [...adminRoutes, ...cronRoutes]) {
    assert.equal(
      classifiedRoutes.has(routeKey),
      true,
      `Expected ${routeKey} to be classified in INTERNAL_ROUTE_TRUST_CONTRACTS`,
    );
  }

  for (const [routeKey, contract] of Object.entries(INTERNAL_ROUTE_TRUST_CONTRACTS)) {
    assert.equal(
      adminRoutes.has(routeKey) || cronRoutes.has(routeKey),
      true,
      `Unexpected non-admin/cron route in INTERNAL_ROUTE_TRUST_CONTRACTS: ${routeKey}`,
    );

    if (contract.trustModel === "internal_admin_session") {
      assert.equal(adminRoutes.has(routeKey), true, `${routeKey} must remain an admin route`);
    }
  }

  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["admin/ebay-deletion-tasks"]?.trustModel,
    "internal_admin_session",
  );
  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["admin/ebay-deletion-tasks/[id]"]?.trustModel,
    "internal_admin_session",
  );
  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["admin/import/pokemontcg-canonical"]?.trustModel,
    "admin_secret",
  );
  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["admin/import/pokemontcg"]?.trustModel,
    "admin_import_token",
  );
  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["cron/sync-canonical"]?.trustModel,
    "cron_secret",
  );
  assert.equal(
    INTERNAL_ROUTE_TRUST_CONTRACTS["cron/process-ebay-deletion-receipts"]?.trustModel,
    "cron_secret",
  );
}
