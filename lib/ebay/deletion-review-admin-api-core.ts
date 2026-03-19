type InternalAdminRouteHeaderInput = {
  cookieHeader?: string | null;
};

export const EBAY_DELETION_REVIEW_ADMIN_API_BASE = "/api/admin/ebay-deletion-tasks";

function normalizeSingleSegment(value: string | null | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.includes("/")) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function appendDefinedQuery(search: URLSearchParams, key: string, value: string | number | null | undefined) {
  if (value === undefined || value === null || value === "") return;
  search.set(key, String(value));
}

export function assertAllowedEbayDeletionReviewAdminApiPath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith(EBAY_DELETION_REVIEW_ADMIN_API_BASE)) {
    throw new Error(`Internal admin review API path must start with ${EBAY_DELETION_REVIEW_ADMIN_API_BASE}.`);
  }

  const parsed = new URL(normalized, "https://internal.popalpha.local");
  if (!parsed.pathname.startsWith(EBAY_DELETION_REVIEW_ADMIN_API_BASE)) {
    throw new Error("Internal admin review API path must stay within the eBay deletion review admin routes.");
  }

  const suffix = parsed.pathname.slice(EBAY_DELETION_REVIEW_ADMIN_API_BASE.length);
  if (!suffix) return `${parsed.pathname}${parsed.search}`;
  if (!suffix.startsWith("/")) {
    throw new Error("Internal admin review API path is malformed.");
  }

  const segments = suffix.split("/").filter(Boolean);
  if (segments.length !== 1) {
    throw new Error("Internal admin review API path must target the list route or a single task detail route.");
  }

  return `${parsed.pathname}${parsed.search}`;
}

export function buildInternalAdminRouteHeaders(input: InternalAdminRouteHeaderInput = {}): Headers {
  const requestHeaders = new Headers();
  requestHeaders.set("accept", "application/json");
  const cookieHeader = input.cookieHeader?.trim() ?? "";
  if (cookieHeader) {
    requestHeaders.set("cookie", cookieHeader);
  }
  return requestHeaders;
}

export function buildEbayDeletionReviewAdminApiPath(input: {
  taskId?: string | null;
  reviewState?: string | null;
  notificationId?: string | null;
  limit?: number | null;
} = {}): string {
  const basePath = input.taskId
    ? `${EBAY_DELETION_REVIEW_ADMIN_API_BASE}/${encodeURIComponent(
        normalizeSingleSegment(input.taskId, "task id"),
      )}`
    : EBAY_DELETION_REVIEW_ADMIN_API_BASE;
  const search = new URLSearchParams();
  appendDefinedQuery(search, "reviewState", input.reviewState ?? undefined);
  appendDefinedQuery(search, "notificationId", input.notificationId ?? undefined);
  appendDefinedQuery(search, "limit", input.limit ?? undefined);
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}
