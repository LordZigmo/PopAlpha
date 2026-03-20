import { getRequiredEnvs } from "@/lib/env";

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

export function getEbayBaseUrl(): string {
  const env = (process.env.EBAY_ENV ?? "production").trim().toLowerCase();
  return env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

export async function getEbayAppAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 20_000) {
    return tokenCache.accessToken;
  }

  const { EBAY_CLIENT_ID: clientId, EBAY_CLIENT_SECRET: clientSecret } = getRequiredEnvs([
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
  ]);

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenUrl = `${getEbayBaseUrl()}/identity/v1/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay token request failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error("eBay token request returned no access_token.");
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + expiresIn * 1000,
  };
  return payload.access_token;
}
