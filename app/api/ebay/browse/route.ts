import { NextResponse } from "next/server";

export const runtime = "nodejs";

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

type EbayBrowseItem = {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  condition?: string;
  itemEndDate?: string;
  seller?: { username?: string };
};

function getEbayBaseUrl(): string {
  const env = (process.env.EBAY_ENV ?? "production").trim().toLowerCase();
  return env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return 12;
  return Math.min(value, 24);
}

async function getAppAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 20_000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenUrl = `${getEbayBaseUrl()}/identity/v1/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const response = await fetch(tokenUrl, {
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

  const payload = (await response.json()) as { access_token: string; expires_in?: number };
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + expiresIn * 1000,
  };
  return payload.access_token;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = parseLimit(url.searchParams.get("limit"));
  if (!q) {
    return NextResponse.json({ ok: false, error: "Missing q query param." }, { status: 400 });
  }

  try {
    const token = await getAppAccessToken();
    const browseUrl = `${getEbayBaseUrl()}/buy/browse/v1/item_summary/search`;
    const params = new URLSearchParams({
      q,
      limit: String(limit),
    });

    const response = await fetch(`${browseUrl}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json({ ok: false, error: `Browse request failed (${response.status}): ${text}` }, { status: 502 });
    }

    const payload = (await response.json()) as { itemSummaries?: EbayBrowseItem[] };
    const items = (payload.itemSummaries ?? []).map((item) => {
      const shipping = item.shippingOptions?.[0]?.shippingCost;
      return {
        externalId: item.itemId ?? "",
        title: item.title ?? "",
        price: item.price?.value
          ? {
              value: item.price.value,
              currency: item.price.currency ?? "USD",
            }
          : null,
        shipping: shipping?.value
          ? {
              value: shipping.value,
              currency: shipping.currency ?? "USD",
            }
          : null,
        itemWebUrl: item.itemWebUrl ?? "",
        image: item.image?.imageUrl ?? null,
        condition: item.condition ?? null,
        endTime: item.itemEndDate ?? null,
        seller: item.seller?.username ?? null,
      };
    });

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
