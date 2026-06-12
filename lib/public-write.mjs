import { createHash } from "node:crypto";

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function hashPublicWriteValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function getPublicWriteIp(req) {
  // Only platform-set headers may key abuse buckets. On Vercel,
  // x-real-ip and x-forwarded-for are overwritten by the platform
  // with the true client IP; cf-connecting-ip is NOT — this app is
  // Vercel-fronted, not behind Cloudflare, so that header arrives
  // client-controlled and an abuser could rotate it to mint a fresh
  // rate-limit bucket per request. Never read it here. (If the app
  // ever moves behind Cloudflare-with-Vercel-origin-lock, it can be
  // reintroduced ABOVE x-real-ip — but only then.)
  return req.headers.get("x-real-ip")?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

export function getPublicWriteFetchSite(req) {
  const fetchSite = normalizeText(req.headers.get("sec-fetch-site"));
  return fetchSite || null;
}

export function isCrossSitePublicWrite(req) {
  return getPublicWriteFetchSite(req) === "cross-site";
}

export function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(Math.max(retryAfterMs, 0) / 1000));
}

export function logPublicWriteEvent(level, payload) {
  const message = JSON.stringify({
    event: "public_write",
    ...payload,
  });

  if (level === "warn") {
    console.warn("[public-write]", message);
    return;
  }

  if (level === "error") {
    console.error("[public-write]", message);
    return;
  }

  console.info("[public-write]", message);
}
