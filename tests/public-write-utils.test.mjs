import assert from "node:assert/strict";
import {
  getPublicWriteFetchSite,
  getPublicWriteIp,
  hashPublicWriteValue,
  isCrossSitePublicWrite,
  retryAfterSeconds,
} from "../lib/public-write.mjs";

export function runPublicWriteUtilsTests() {
  const request = new Request("https://popalpha.app/api/test", {
    headers: {
      "cf-connecting-ip": "203.0.113.42",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(getPublicWriteIp(request), "203.0.113.42");
  assert.equal(getPublicWriteFetchSite(request), "cross-site");
  assert.equal(isCrossSitePublicWrite(request), true);
  assert.equal(hashPublicWriteValue("collector@example.com")?.length, 16);
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(1_250), 2);

  const forwardedRequest = new Request("https://popalpha.app/api/test", {
    headers: {
      "x-forwarded-for": "198.51.100.8, 10.0.0.1",
      "sec-fetch-site": "same-origin",
    },
  });

  assert.equal(getPublicWriteIp(forwardedRequest), "198.51.100.8");
  assert.equal(getPublicWriteFetchSite(forwardedRequest), "same-origin");
  assert.equal(isCrossSitePublicWrite(forwardedRequest), false);
}
