import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import {
  DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
  DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS,
  DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS,
  MAX_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
  processEbayDeletionReceiptBatch,
} from "@/lib/ebay/deletion-receipt-processor";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const batchSize = Math.max(
    1,
    Math.min(
      parseOptionalInt(url.searchParams.get("limit")) ?? DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
      MAX_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
    ),
  );
  const maxAttempts = Math.max(
    1,
    Math.min(parseOptionalInt(url.searchParams.get("maxAttempts")) ?? DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS, 20),
  );
  const staleAfterSeconds = Math.max(
    60,
    parseOptionalInt(url.searchParams.get("staleAfterSeconds")) ?? DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS,
  );
  const workerId = url.searchParams.get("workerId")?.trim() || "vercel-cron";

  const result = await processEbayDeletionReceiptBatch({
    workerId,
    batchSize,
    maxAttempts,
    staleAfterSeconds,
  });

  return NextResponse.json({
    ok: true,
    ...result,
    mode: "manual-review-queue-only",
  });
}
