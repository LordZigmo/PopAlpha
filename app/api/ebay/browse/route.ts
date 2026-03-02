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

function normalizedPhrase(value: string | null | undefined): string {
  return normalizeTitle(value);
}

function hasMatchingCardNumber(title: string, cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const numeric = cardNumber.replace(/[^0-9]/g, "");
  if (!numeric) return false;
  return new RegExp(`(^|[^0-9])${numeric}([^0-9]|$)`).test(title);
}

function mentionsDifferentSet(title: string, setName: string | null): boolean {
  const requestedSet = normalizedPhrase(setName);
  if (!requestedSet) return false;
  if (title.includes(requestedSet)) return false;

  const setTokens = requestedSet.split(" ").filter(Boolean);
  if (setTokens.length < 2) return false;

  const anchor = setTokens[setTokens.length - 1];
  if (!anchor || !title.includes(anchor)) return false;

  const phrases = title.match(new RegExp(`(?:\\b[a-z0-9']+\\s+){0,2}${anchor}\\b`, "g")) ?? [];
  return phrases.some((phrase) => {
    const normalized = phrase.replace(/\s+/g, " ").trim();
    return normalized.length > anchor.length && normalized !== requestedSet;
  });
}

function evaluateRequestedCard(
  item: ReturnType<typeof mapBrowseItem>,
  input: {
    canonicalName: string;
    setName: string | null;
    cardNumber: string | null;
    finish: string | null;
    grade: string;
  }
): { matches: boolean; score: number } {
  const title = normalizeTitle(item.title);
  if (!title) return { matches: false, score: 0 };

  const canonicalPhrase = normalizedPhrase(input.canonicalName);
  const nameTokens = buildNameTokens(input.canonicalName);
  if (!canonicalPhrase || nameTokens.length === 0) return { matches: false, score: 0 };
  if (!title.includes(canonicalPhrase)) return { matches: false, score: 0 };
  if (mentionsDifferentSet(title, input.setName)) return { matches: false, score: 0 };

  let score = 100;

  if (input.grade === "RAW") {
    if (/\b(psa|cgc|bgs|beckett|tag|graded|slab|sgc)\b/.test(title)) return { matches: false, score: 0 };
  }

  const finish = (input.finish ?? "").toUpperCase();
  if (finish === "REVERSE_HOLO") {
    if (!title.includes("reverse")) return { matches: false, score: 0 };
    score += 20;
  }
  if (finish === "NON_HOLO") {
    if (title.includes("reverse holo") || title.includes("reverse")) return { matches: false, score: 0 };
  }

  const requestedSet = normalizedPhrase(input.setName);
  if (requestedSet && title.includes(requestedSet)) {
    score += 40;
  }

  if (hasMatchingCardNumber(title, input.cardNumber)) {
    score += 15;
  }

  return { matches: true, score };
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
  const setName = url.searchParams.get("setName")?.trim() ?? null;
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
    const dedupedItems = new Map<string, ReturnType<typeof mapBrowseItem> & { _matchScore?: number }>();

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
        const evaluation = evaluateRequestedCard(mapped, { canonicalName, setName, cardNumber, finish, grade });
        if (!evaluation.matches) continue;
        const dedupeKey = mapped.externalId || mapped.itemWebUrl || `${mapped.title}:${mapped.price?.value ?? ""}`;
        if (!dedupeKey || dedupedItems.has(dedupeKey)) continue;
        dedupedItems.set(dedupeKey, { ...mapped, _matchScore: evaluation.score });
      }

      if (dedupedItems.size >= limit) break;
    }

    const sortedItems = [...dedupedItems.values()].sort((left, right) => {
      const scoreDelta = Number(right._matchScore ?? 0) - Number(left._matchScore ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      const leftPrice = left.price?.value ? Number.parseFloat(left.price.value) : Number.POSITIVE_INFINITY;
      const rightPrice = right.price?.value ? Number.parseFloat(right.price.value) : Number.POSITIVE_INFINITY;
      return leftPrice - rightPrice;
    }).map(({ _matchScore, ...item }) => item);

    return NextResponse.json({
      ok: true,
      total: dedupedItems.size,
      items: sortedItems.slice(0, limit),
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
