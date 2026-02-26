const LOCAL_DEV_ORIGIN = "http://localhost:3000";

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/$/, "");
}

export function getSiteUrl(): string {
  const configuredOrigin = normalizeOrigin(
    process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "",
  );

  if (configuredOrigin) {
    return configuredOrigin;
  }

  const vercelOrigin = normalizeOrigin(process.env.VERCEL_URL ?? "");
  if (vercelOrigin) {
    return vercelOrigin.startsWith("http")
      ? vercelOrigin
      : `https://${vercelOrigin}`;
  }

  if (typeof window !== "undefined" && window.location.origin) {
    return normalizeOrigin(window.location.origin);
  }

  return LOCAL_DEV_ORIGIN;
}
