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

type EbayBrowseResponse = {
  itemSummaries?: EbayBrowseItem[];
  total?: number;
};

function getEbayBaseUrl(): string {
  const env = (process.env.EBAY_ENV ?? "production").trim().toLowerCase();
  return env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(value, 60);
}

function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNameTokens(name: string): string[] {
  return normalizeTitle(name)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function hasNumberToken(title: string, cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const numeric = cardNumber.replace(/[^0-9]/g, "");
  if (!numeric) return false;
  return new RegExp(`(^|[^0-9])${numeric}([^0-9]|$)`).test(title);
}

function matchesRequestedCard(
  item: ReturnType<typeof mapBrowseItem>,
  input: {
    canonicalName: string;
    cardNumber: string | null;
    finish: string | null;
    grade: string;
  },
): boolean {
  const title = normalizeTitle(item.title);
  if (!title) return false;

  const nameTokens = buildNameTokens(input.canonicalName);
  if (nameTokens.length === 0) return false;
  if (!nameTokens.every((token) => title.includes(token))) return false;

  if (input.cardNumber && !hasNumberToken(title, input.cardNumber)) {
    return false;
  }

  if (input.grade === "RAW") {
    if (/\b(psa|cgc|bgs|beckett|tag|graded|slab|sgc)\b/.test(title)) return false;
  }

  const finish = (input.finish ?? "").toUpperCase();
  if (finish === "REVERSE_HOLO") {
    if (!title.includes("reverse")) return false;
  }
  if (finish === "NON_HOLO") {
    if (title.includes("reverse holo") || title.includes("reverse")) return false;
  }

  return true;
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
  const queries = url.searchParams.getAll("q").map(normalizeQuery).filter(Boolean);
  const uniqueQueries = [...new Set(queries)];
  const q = uniqueQueries[0] ?? "";
  const canonicalName = url.searchParams.get("canonicalName")?.trim() ?? "";
  const cardNumber = url.searchParams.get("cardNumber")?.trim() ?? null;
  const finish = url.searchParams.get("finish")?.trim() ?? null;
  const grade = url.searchParams.get("grade")?.trim() ?? "RAW";
  const limit = parseLimit(url.searchParams.get("limit"));
  if (!q) {
    return NextResponse.json({ ok: false, error: "Missing q query param." }, { status: 400 });
  }
  if (!canonicalName) {
    return NextResponse.json({ ok: false, error: "Missing canonicalName query param." }, { status: 400 });
  }

  try {
    const token = await getAppAccessToken();
    const browseUrl = `${getEbayBaseUrl()}/buy/browse/v1/item_summary/search`;
    const dedupedItems = new Map<string, ReturnType<typeof mapBrowseItem>>();

    for (const query of uniqueQueries) {
      const params = new URLSearchParams({
        q: query,
        limit: String(Math.min(limit, 50)),
        filter: "buyingOptions:{FIXED_PRICE}",
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

      const payload = (await response.json()) as EbayBrowseResponse;
      for (const item of payload.itemSummaries ?? []) {
        const mapped = mapBrowseItem(item);
        if (!matchesRequestedCard(mapped, { canonicalName, cardNumber, finish, grade })) continue;
        const dedupeKey = mapped.externalId || mapped.itemWebUrl || `${mapped.title}:${mapped.price?.value ?? ""}`;
        if (!dedupeKey || dedupedItems.has(dedupeKey)) continue;
        dedupedItems.set(dedupeKey, mapped);
      }

      if (dedupedItems.size >= limit) break;
    }

    return NextResponse.json({
      ok: true,
      total: dedupedItems.size,
      items: [...dedupedItems.values()].slice(0, limit),
      queriesUsed: uniqueQueries,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

function mapBrowseItem(item: EbayBrowseItem) {
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
}
