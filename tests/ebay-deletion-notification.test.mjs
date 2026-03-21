import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import {
  EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_TTL_MS,
  EbayDeletionNotificationError,
  handleEbayDeletionNotification,
  loadEbayNotificationPublicKey,
  resetEbayNotificationPublicKeyCacheForTests,
  verifyEbayDeletionNotificationSignature,
} from "../lib/ebay/deletion-notification.ts";

function buildPayload() {
  return {
    metadata: {
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      schemaVersion: "1.0",
    },
    notification: {
      notificationId: "notif-123",
      eventDate: "2026-03-18T16:20:00.000Z",
      publishDate: "2026-03-18T16:20:05.000Z",
      publishAttemptCount: 1,
      data: {
        userId: "ebay-user-123",
        username: "collector_alpha",
        eiasToken: "eias-token-abc",
      },
    },
  };
}

function buildRawBody(payload, pretty = false) {
  return Buffer.from(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
}

function buildSignedHeader(rawBody, privateKey, overrides = {}) {
  const signature = signPayload("sha1", rawBody, privateKey).toString("base64");
  return Buffer.from(JSON.stringify({
    alg: "ECDSA",
    kid: "test-key-1",
    digest: "SHA1",
    signature,
    ...overrides,
  })).toString("base64");
}

function buildPublicKeyLoader(publicKey) {
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return async () => ({
    algorithm: "ECDSA",
    digest: "SHA1",
    key,
  });
}

async function readJson(response) {
  return response.json();
}

export async function runEbayDeletionNotificationTests() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const payload = buildPayload();
  const prettyRawBody = buildRawBody(payload, true);
  const compactRawBody = buildRawBody(payload, false);
  const signatureHeader = buildSignedHeader(prettyRawBody, privateKey);
  const loadPublicKey = buildPublicKeyLoader(publicKey);
  const encodedPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  const verification = await verifyEbayDeletionNotificationSignature({
    rawBody: prettyRawBody,
    signatureHeader,
    loadPublicKey,
  });
  assert.equal(verification.header.kid, "test-key-1");
  assert.equal(verification.header.alg, "ECDSA");
  assert.equal(verification.header.digest, "SHA1");
  assert.equal(verification.publicKey.algorithm, "ECDSA");
  assert.equal(verification.publicKey.digest, "SHA1");
  assert.equal(verification.payloadSha256.length, 64);

  await assert.rejects(
    () => verifyEbayDeletionNotificationSignature({
      rawBody: compactRawBody,
      signatureHeader,
      loadPublicKey,
    }),
    (error) => error instanceof EbayDeletionNotificationError && error.kind === "bad_signature",
  );

  {
    resetEbayNotificationPublicKeyCacheForTests();
    let keyFetches = 0;
    const fetchImpl = async () => {
      keyFetches += 1;
      return Response.json({
        algorithm: "ECDSA",
        digest: "SHA1",
        key: encodedPublicKey,
      });
    };

    const first = await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.ebay.com",
      now: () => 10_000,
      getAccessToken: async () => "token",
    });
    const second = await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.ebay.com",
      now: () => 10_500,
      getAccessToken: async () => "token",
    });

    assert.equal(keyFetches, 1);
    assert.deepEqual(second, first);
  }

  {
    resetEbayNotificationPublicKeyCacheForTests();
    let keyFetches = 0;
    const fetchImpl = async () => {
      keyFetches += 1;
      return Response.json({
        algorithm: "ECDSA",
        digest: "SHA1",
        key: encodedPublicKey,
      });
    };

    await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.ebay.com",
      now: () => 20_000,
      getAccessToken: async () => "token",
    });
    await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.ebay.com",
      now: () => 20_000 + EBAY_NOTIFICATION_PUBLIC_KEY_CACHE_TTL_MS + 1,
      getAccessToken: async () => "token",
    });

    assert.equal(keyFetches, 2);
  }

  {
    resetEbayNotificationPublicKeyCacheForTests();
    let keyFetches = 0;
    const fetchImpl = async () => {
      keyFetches += 1;
      return Response.json({
        algorithm: "ECDSA",
        digest: "SHA1",
        key: encodedPublicKey,
      });
    };

    await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.ebay.com",
      now: () => 30_000,
      getAccessToken: async () => "token",
    });
    await loadEbayNotificationPublicKey("test-key-1", {
      fetchImpl,
      baseUrl: "https://api.sandbox.ebay.com",
      now: () => 30_500,
      getAccessToken: async () => "token",
    });

    assert.equal(keyFetches, 2);
  }

  {
    resetEbayNotificationPublicKeyCacheForTests();
    await assert.rejects(
      () => loadEbayNotificationPublicKey("test-key-1", {
        fetchImpl: async () => new Response("upstream unavailable", { status: 503 }),
        baseUrl: "https://api.ebay.com",
        now: () => 40_000,
        getAccessToken: async () => "token",
      }),
      (error) => error instanceof EbayDeletionNotificationError && error.kind === "public_key_lookup_failed",
    );
  }

  {
    let persistCalls = 0;
    const logs = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: prettyRawBody,
        headers: {
          "content-type": "application/json",
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        persistReceipt: async () => {
          persistCalls += 1;
          return { stored: true };
        },
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(persistCalls, 0);
    assert.equal(logs[0]?.payload?.outcome, "rejected_missing_headers");
    assert.match((await readJson(response)).error, /Missing X-EBAY-SIGNATURE header/i);
  }

  {
    let persistCalls = 0;
    const logs = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: prettyRawBody,
        headers: {
          "content-type": "application/json",
          "x-ebay-signature": "not-base64",
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        verifyNotification: ({ rawBody, signatureHeader }) => verifyEbayDeletionNotificationSignature({
          rawBody,
          signatureHeader,
          loadPublicKey,
        }),
        persistReceipt: async () => {
          persistCalls += 1;
          return { stored: true };
        },
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(persistCalls, 0);
    assert.equal(logs[0]?.payload?.outcome, "rejected_malformed");
    assert.equal(logs[0]?.payload?.reason, "malformed_signature_header");
  }

  {
    let persistCalls = 0;
    const logs = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: compactRawBody,
        headers: {
          "content-type": "application/json",
          "x-ebay-signature": signatureHeader,
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        verifyNotification: ({ rawBody, signatureHeader: currentSignatureHeader }) => verifyEbayDeletionNotificationSignature({
          rawBody,
          signatureHeader: currentSignatureHeader,
          loadPublicKey,
        }),
        persistReceipt: async () => {
          persistCalls += 1;
          return { stored: true };
        },
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 412);
    assert.equal(persistCalls, 0);
    assert.equal(logs[0]?.payload?.outcome, "rejected_bad_signature");
    assert.equal(logs[0]?.payload?.reason, "bad_signature");
  }

  {
    resetEbayNotificationPublicKeyCacheForTests();
    let persistCalls = 0;
    const logs = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: prettyRawBody,
        headers: {
          "content-type": "application/json",
          "x-ebay-signature": signatureHeader,
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        verifyNotification: ({ rawBody, signatureHeader: currentSignatureHeader }) => verifyEbayDeletionNotificationSignature({
          rawBody,
          signatureHeader: currentSignatureHeader,
          loadPublicKey: (keyId) => loadEbayNotificationPublicKey(keyId, {
            fetchImpl: async () => new Response("upstream unavailable", { status: 503 }),
            baseUrl: "https://api.ebay.com",
            now: () => 50_000,
            getAccessToken: async () => "token",
          }),
        }),
        persistReceipt: async () => {
          persistCalls += 1;
          return { stored: true };
        },
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 503);
    assert.equal(persistCalls, 0);
    assert.equal(logs[0]?.payload?.outcome, "error");
    assert.equal(logs[0]?.payload?.reason, "public_key_lookup_failed");
  }

  {
    const logs = [];
    const persisted = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: prettyRawBody,
        headers: {
          "content-type": "application/json",
          "x-ebay-signature": signatureHeader,
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        verifyNotification: async ({ rawBody }) => {
          assert.equal(Buffer.compare(rawBody, prettyRawBody), 0);
          return {
            header: {
              alg: "ECDSA",
              digest: "SHA1",
              kid: "test-key-1",
            },
            publicKey: {
              algorithm: "ECDSA",
              digest: "SHA1",
            },
            payloadSha256: "f".repeat(64),
          };
        },
        persistReceipt: async (receipt) => {
          persisted.push(receipt);
          return { stored: true };
        },
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].payload.notification.notificationId, "notif-123");
    assert.equal(persisted[0].verification.header.kid, "test-key-1");
    assert.equal(logs[0]?.payload?.outcome, "accepted_verified");
    assert.deepEqual(await readJson(response), { received: true });
  }

  {
    const logs = [];
    const response = await handleEbayDeletionNotification(
      new Request("https://popalpha.app/api/ebay/deletion-notification", {
        method: "POST",
        body: prettyRawBody,
        headers: {
          "content-type": "application/json",
          "x-ebay-signature": signatureHeader,
        },
      }),
      {
        rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        verifyNotification: async () => ({
          header: {
            alg: "ECDSA",
            digest: "SHA1",
            kid: "test-key-1",
          },
          publicKey: {
            algorithm: "ECDSA",
            digest: "SHA1",
          },
          payloadSha256: "e".repeat(64),
        }),
        persistReceipt: async () => ({ stored: false }),
        logEvent: (level, payload) => logs.push({ level, payload }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(logs[0]?.payload?.outcome, "accepted_verified_duplicate");
  }
}
