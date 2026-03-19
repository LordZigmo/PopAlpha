import "server-only";

import { headers } from "next/headers.js";
import { getSiteUrl } from "@/lib/site-url";
import {
  assertAllowedEbayDeletionReviewAdminApiPath,
  buildEbayDeletionReviewAdminApiPath,
  buildInternalAdminRouteHeaders,
} from "@/lib/ebay/deletion-review-admin-api-core";
import type {
  EbayDeletionManualReviewState,
  EbayDeletionReviewTaskDetailView,
  EbayDeletionReviewTaskView,
} from "@/lib/ebay/deletion-review";

type ReviewListResponse = {
  ok: true;
  mode: "manual_review_only";
  allowedReviewStates: EbayDeletionManualReviewState[];
  filters: {
    reviewState: EbayDeletionManualReviewState | null;
    notificationId: string | null;
    limit: number | null;
  };
  summary: {
    total: number;
    byReviewState: Record<EbayDeletionManualReviewState, number>;
  };
  tasks: EbayDeletionReviewTaskView[];
};

type ReviewDetailResponse = {
  ok: true;
  mode: "manual_review_only";
  allowedReviewStates: EbayDeletionManualReviewState[];
} & EbayDeletionReviewTaskDetailView;

type ReviewRouteError = {
  ok: false;
  error: string;
  code?: string;
};

type ReviewUpdatePayload = {
  reviewState?: EbayDeletionManualReviewState;
  reviewNotes?: string | null;
  candidateMatch?: { clerkUserId: string; handleNorm: string } | null;
};

export class InternalAdminReviewApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getInternalRequestOrigin(): Promise<string> {
  const headerStore = await headers();
  const forwardedHost = headerStore.get("x-forwarded-host")?.trim();
  const host = forwardedHost || headerStore.get("host")?.trim();
  const forwardedProto = headerStore.get("x-forwarded-proto")?.trim();

  if (host) {
    const protocol = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${protocol}://${host}`;
  }

  return getSiteUrl();
}

async function fetchInternalReviewApi<T>(
  path: string,
  input: {
    method?: "GET" | "PATCH";
    body?: ReviewUpdatePayload;
  },
): Promise<T> {
  const origin = await getInternalRequestOrigin();
  const currentHeaders = await headers();
  const cookieHeader = currentHeaders.get("cookie")?.trim() ?? "";
  if (!cookieHeader) {
    throw new Error("Internal admin review API fetch requires forwarded request cookies.");
  }
  const url = new URL(assertAllowedEbayDeletionReviewAdminApiPath(path), origin);
  const requestHeaders = buildInternalAdminRouteHeaders({ cookieHeader });
  const init: RequestInit = {
    method: input.method ?? "GET",
    headers: requestHeaders,
    cache: "no-store",
  };

  if (input.body) {
    requestHeaders.set("content-type", "application/json");
    init.body = JSON.stringify(input.body);
  }

  const response = await fetch(url, init);
  const payload = (await response.json()) as ReviewListResponse | ReviewDetailResponse | ReviewRouteError;

  if (!response.ok) {
    const error = payload as ReviewRouteError;
    throw new InternalAdminReviewApiError(
      error.error || `Internal admin review API request failed with ${response.status}.`,
      response.status,
      error.code,
    );
  }

  return payload as T;
}

export async function listInternalAdminEbayDeletionTasks(
  input: {
    reviewState?: EbayDeletionManualReviewState | null;
    notificationId?: string | null;
    limit?: number | null;
  } = {},
): Promise<ReviewListResponse> {
  return fetchInternalReviewApi<ReviewListResponse>(
    buildEbayDeletionReviewAdminApiPath({
      reviewState: input.reviewState ?? null,
      notificationId: input.notificationId ?? null,
      limit: input.limit ?? null,
    }),
    {},
  );
}

export async function getInternalAdminEbayDeletionTaskDetail(
  taskId: string,
): Promise<ReviewDetailResponse> {
  return fetchInternalReviewApi<ReviewDetailResponse>(
    buildEbayDeletionReviewAdminApiPath({ taskId }),
    {},
  );
}

export async function patchInternalAdminEbayDeletionTask(
  taskId: string,
  payload: ReviewUpdatePayload,
): Promise<ReviewDetailResponse> {
  return fetchInternalReviewApi<ReviewDetailResponse>(
    buildEbayDeletionReviewAdminApiPath({ taskId }),
    { method: "PATCH", body: payload },
  );
}
