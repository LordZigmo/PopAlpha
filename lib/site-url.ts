const LOCAL_DEV_ORIGIN = "http://localhost:3000";
const PRIMARY_PRODUCTION_ORIGIN = "https://popalpha.ai";
const LEGACY_PRODUCTION_HOSTS = new Set(["popalpha.app", "www.popalpha.app"]);
const PRIMARY_PRODUCTION_HOSTS = new Set(["popalpha.ai", "www.popalpha.ai"]);

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/$/, "");
}

function normalizeSiteOrigin(value: string): string {
  const normalized = normalizeOrigin(value);
  if (!normalized) return "";

  const withProtocol = normalized.startsWith("http")
    ? normalized
    : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase();

    if (LEGACY_PRODUCTION_HOSTS.has(hostname) || PRIMARY_PRODUCTION_HOSTS.has(hostname)) {
      return PRIMARY_PRODUCTION_ORIGIN;
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized;
  }
}

export function getSiteUrl(): string {
  const configuredOrigin = normalizeSiteOrigin(
    process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "",
  );

  if (configuredOrigin) {
    return configuredOrigin;
  }

  const vercelOrigin = normalizeSiteOrigin(process.env.VERCEL_URL ?? "");
  if (vercelOrigin) {
    if (process.env.VERCEL_ENV === "production") {
      return PRIMARY_PRODUCTION_ORIGIN;
    }
    return vercelOrigin;
  }

  if (typeof window !== "undefined" && window.location.origin) {
    return normalizeSiteOrigin(window.location.origin);
  }

  return LOCAL_DEV_ORIGIN;
}
