import assert from "node:assert/strict";
import { DEBUG_ROUTES } from "../lib/auth/route-registry.ts";
import { DEBUG_ROUTE_TRUST_CONTRACTS } from "../scripts/security-guardrails.config.mjs";

export function runDebugRouteTrustTests() {
  const debugRoutes = new Set(DEBUG_ROUTES);
  const classifiedRoutes = new Set(Object.keys(DEBUG_ROUTE_TRUST_CONTRACTS));

  for (const routeKey of debugRoutes) {
    assert.equal(
      classifiedRoutes.has(routeKey),
      true,
      `Expected ${routeKey} to be classified in DEBUG_ROUTE_TRUST_CONTRACTS`,
    );
  }

  for (const [routeKey, contract] of Object.entries(DEBUG_ROUTE_TRUST_CONTRACTS)) {
    assert.equal(
      debugRoutes.has(routeKey),
      true,
      `Unexpected non-debug route in DEBUG_ROUTE_TRUST_CONTRACTS: ${routeKey}`,
    );
    assert.equal(contract.registryKind, "debug", `${routeKey} must remain a debug route`);
  }

  assert.equal(DEBUG_ROUTE_TRUST_CONTRACTS["debug/market-summary"]?.trustModel, "debug_cron_guard");
  assert.equal(DEBUG_ROUTE_TRUST_CONTRACTS["debug/justtcg/backfill-set"]?.trustModel, "debug_cron_guard");
  assert.equal(DEBUG_ROUTE_TRUST_CONTRACTS["debug/tracked-assets/seed"]?.trustModel, "debug_cron_guard");
}
