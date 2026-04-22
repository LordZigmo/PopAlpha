import assert from "node:assert/strict";

import {
  buildGuestActorKey,
  buildUserActorKey,
  generateGuestRandomPart,
  isGuestActorKey,
  isUserActorKey,
  isValidActorKey,
  mintGuestActorKey,
} from "@/lib/personalization/actor.ts";

export async function runActorMappingTests() {
  // ── Minting always produces valid guest keys ──────────────────────────────
  {
    for (let i = 0; i < 10; i++) {
      const key = mintGuestActorKey();
      assert.ok(key.startsWith("guest:"), `minted key must start with guest: — got ${key}`);
      assert.ok(isValidActorKey(key), `minted key must validate: ${key}`);
      assert.ok(isGuestActorKey(key));
      assert.ok(!isUserActorKey(key));
    }
  }

  // ── User key format ──────────────────────────────────────────────────────
  {
    const key = buildUserActorKey("user_2abc123");
    assert.equal(key, "user:user_2abc123");
    assert.ok(isValidActorKey(key));
    assert.ok(isUserActorKey(key));
    assert.ok(!isGuestActorKey(key));
  }

  // ── Validation rejects garbage ───────────────────────────────────────────
  {
    assert.equal(isValidActorKey(null), false);
    assert.equal(isValidActorKey(""), false);
    assert.equal(isValidActorKey("short"), false);
    assert.equal(isValidActorKey("noprefix-1234567890"), false);
    assert.equal(isValidActorKey("guest:" + "x".repeat(250)), false, "must reject oversized keys");
  }

  // ── generateGuestRandomPart produces distinct values under load ──────────
  {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      seen.add(generateGuestRandomPart());
    }
    assert.ok(seen.size >= 95, `generateGuestRandomPart collision rate too high: ${seen.size}/100`);
  }

  // ── buildGuestActorKey is a pure prefix operation ────────────────────────
  {
    assert.equal(buildGuestActorKey("abc"), "guest:abc");
    assert.equal(buildGuestActorKey("abc-def-123"), "guest:abc-def-123");
  }

  console.log("  actor-mapping: ok");
}
