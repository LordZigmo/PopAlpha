const PSA_BASE_URL = "https://api.psacard.com";
// PSA Public API docs: GET /publicapi/cert/GetByCertNumber/{certNo}
const CERTIFICATE_ENDPOINT_TEMPLATE = "/publicapi/cert/GetByCertNumber/{certNo}";

const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;

type ParsedCertificate = {
  cert_no: string;
  grade: string | null;
  label: string | null;
  year: number | null;
  set_name: string | null;
  subject: string | null;
  variety: string | null;
  image_url: string | null;
};

type CertificateResponse = {
  parsed: ParsedCertificate;
  raw: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

function normalizePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const result = raw.Result;
  if (result && typeof result === "object") {
    return result as Record<string, unknown>;
  }

  const data = raw.data;
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }

  return raw;
}

function buildCertificateUrl(certNo: string): string {
  return `${PSA_BASE_URL}${CERTIFICATE_ENDPOINT_TEMPLATE.replace("{certNo}", encodeURIComponent(certNo))}`;
}

export async function getCertificate(certNo: string): Promise<CertificateResponse> {
  const token = process.env.PSA_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing PSA_ACCESS_TOKEN env var (server-only).");
  }

  const url = buildCertificateUrl(certNo);
  let backoffMs = INITIAL_BACKOFF_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
        const retryDelayMs = Number.isFinite(retryAfterSeconds)
          ? Math.max(retryAfterSeconds, 1) * 1000
          : backoffMs;

        await sleep(retryDelayMs);
        backoffMs *= 2;
        continue;
      }

      if (!response.ok) {
        const bodySnippet = (await response.text()).slice(0, 500);
        throw new Error(
          `PSA request failed for cert ${certNo}: HTTP ${response.status}. Response: ${bodySnippet}`
        );
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const normalized = normalizePayload(raw);
      const parsed: ParsedCertificate = {
        cert_no: certNo,
        grade: firstString(normalized, ["grade", "Grade"]),
        label: firstString(normalized, ["label", "Label", "certLabel"]),
        year: parseYear(normalized.year ?? normalized.Year),
        set_name: firstString(normalized, ["set_name", "setName", "SetName"]),
        subject: firstString(normalized, ["subject", "Subject", "player"]),
        variety: firstString(normalized, ["variety", "Variety"]),
        image_url: firstString(normalized, ["image_url", "imageUrl", "ImageURL"]),
      };

      return { parsed, raw };
    } catch (error) {
      lastError = error;

      if (attempt >= MAX_ATTEMPTS) {
        break;
      }

      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }

  throw new Error(
    `PSA request failed for cert ${certNo} after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`
  );
}
