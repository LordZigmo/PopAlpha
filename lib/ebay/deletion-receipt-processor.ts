import {
  type EbayDeletionNotificationPayload,
  parseEbayDeletionNotificationPayloadValue,
} from "@/lib/ebay/deletion-notification";
import { type EbayDeletionManualReviewState } from "@/lib/ebay/deletion-review";

export const DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT = 10;
export const MAX_EBAY_DELETION_RECEIPT_BATCH_LIMIT = 25;
export const DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS = 5;
export const DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS = 1800;
const MAX_ERROR_SUMMARY_LENGTH = 8000;

export type EbayDeletionReceiptProcessingStatus = "received" | "processing" | "processed" | "failed";
export type EbayDeletionReceiptProcessingOutcome =
  | "manual_review_task_created"
  | "manual_review_task_existing";

class EbayDeletionReceiptProcessingError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type ClaimedEbayDeletionReceiptRow = {
  id: string;
  notification_id: string;
  topic: string;
  schema_version: string;
  publish_attempt_count: number;
  payload: unknown;
  processing_status: EbayDeletionReceiptProcessingStatus;
  processing_worker: string | null;
  attempt_count: number;
  received_at: string;
};

type ManualReviewTaskInsertInput = {
  receiptId: string;
  notificationId: string;
  topic: string;
  eventDate: string;
  publishDate: string;
  ebayUserId: string;
  ebayUsername: string | null;
  reviewState: EbayDeletionManualReviewState;
};

type ManualReviewTaskInsertResult = {
  created: boolean;
};

type ReceiptStore = {
  claimReceipts(input: {
    workerId: string;
    batchSize: number;
    maxAttempts: number;
    staleAfterSeconds: number;
  }): Promise<ClaimedEbayDeletionReceiptRow[]>;
  insertManualReviewTask(input: ManualReviewTaskInsertInput): Promise<ManualReviewTaskInsertResult>;
  markReceiptProcessed(input: {
    receiptId: string;
    workerId: string;
    outcome: EbayDeletionReceiptProcessingOutcome;
  }): Promise<void>;
  markReceiptFailed(input: {
    receiptId: string;
    workerId: string;
    errorCode: string;
    errorSummary: string;
  }): Promise<void>;
};

type ProcessReceiptRun = {
  receiptId: string;
  notificationId: string;
  ok: boolean;
  status: EbayDeletionReceiptProcessingStatus;
  outcome: EbayDeletionReceiptProcessingOutcome | null;
  errorCode: string | null;
  error: string | null;
};

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

function normalizeWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  return normalized || "worker";
}

function clampPositiveInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(value), max));
}

function normalizeReceiptPayload(
  receipt: Pick<ClaimedEbayDeletionReceiptRow, "notification_id" | "payload" | "topic">,
): EbayDeletionNotificationPayload {
  const payload = parseEbayDeletionNotificationPayloadValue(receipt.payload);
  if (payload.notification.notificationId !== receipt.notification_id) {
    throw new EbayDeletionReceiptProcessingError(
      "INVALID_RECEIPT_PAYLOAD",
      "Stored receipt notification_id does not match payload.notification.notificationId.",
    );
  }
  if (payload.metadata.topic !== receipt.topic) {
    throw new EbayDeletionReceiptProcessingError(
      "INVALID_RECEIPT_PAYLOAD",
      "Stored receipt topic does not match payload.metadata.topic.",
    );
  }
  return payload;
}

function deriveTaskInput(
  receipt: Pick<ClaimedEbayDeletionReceiptRow, "id">,
  payload: EbayDeletionNotificationPayload,
): ManualReviewTaskInsertInput {
  return {
    receiptId: receipt.id,
    notificationId: payload.notification.notificationId,
    topic: payload.metadata.topic,
    eventDate: payload.notification.eventDate,
    publishDate: payload.notification.publishDate,
    ebayUserId: payload.notification.data.userId,
    ebayUsername: payload.notification.data.username,
    reviewState: "pending_review",
  };
}

function errorCodeForReceipt(error: unknown): string {
  if (error instanceof EbayDeletionReceiptProcessingError) {
    return error.code;
  }
  if (error instanceof Error) {
    const upper = error.name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    return upper || "PROCESSING_ERROR";
  }
  return "PROCESSING_ERROR";
}

async function getAdminSupabase() {
  const { dbAdmin: getAdminClient } = await import("@/lib/db/admin");
  return getAdminClient();
}

function createDbReceiptStore(): ReceiptStore {
  return {
    async claimReceipts({ workerId, batchSize, maxAttempts, staleAfterSeconds }) {
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase.rpc("claim_ebay_deletion_notification_receipts", {
        p_worker: workerId,
        p_batch_size: batchSize,
        p_max_attempts: maxAttempts,
        p_stale_after_seconds: staleAfterSeconds,
      });
      if (error) {
        throw new Error(`claim_ebay_deletion_notification_receipts: ${error.message}`);
      }
      return (data ?? []) as ClaimedEbayDeletionReceiptRow[];
    },
    async insertManualReviewTask(input) {
      const supabase = await getAdminSupabase();
      const { error } = await supabase
        .from("ebay_deletion_manual_review_tasks")
        .insert({
          receipt_id: input.receiptId,
          notification_id: input.notificationId,
          topic: input.topic,
          event_date: input.eventDate,
          publish_date: input.publishDate,
          ebay_user_id: input.ebayUserId,
          ebay_username: input.ebayUsername,
          review_status: "OPEN",
          review_state: input.reviewState,
          review_state_updated_at: new Date().toISOString(),
        });

      if (!error) {
        return { created: true };
      }
      if (error.code === "23505") {
        return { created: false };
      }
      throw new Error(`ebay_deletion_manual_review_tasks(insert): ${error.message}`);
    },
    async markReceiptProcessed({ receiptId, workerId, outcome }) {
      const supabase = await getAdminSupabase();
      const { error } = await supabase
        .from("ebay_deletion_notification_receipts")
        .update({
          processing_status: "processed",
          processing_worker: workerId,
          processing_outcome: outcome,
          processed_at: new Date().toISOString(),
          failed_at: null,
          last_error_code: null,
          last_error_summary: null,
        })
        .eq("id", receiptId)
        .eq("processing_status", "processing")
        .eq("processing_worker", workerId);

      if (error) {
        throw new Error(`ebay_deletion_notification_receipts(mark processed): ${error.message}`);
      }
    },
    async markReceiptFailed({ receiptId, workerId, errorCode, errorSummary }) {
      const supabase = await getAdminSupabase();
      const { error } = await supabase
        .from("ebay_deletion_notification_receipts")
        .update({
          processing_status: "failed",
          processing_worker: workerId,
          failed_at: new Date().toISOString(),
          last_error_code: errorCode,
          last_error_summary: errorSummary.slice(0, MAX_ERROR_SUMMARY_LENGTH),
        })
        .eq("id", receiptId)
        .eq("processing_status", "processing")
        .eq("processing_worker", workerId);

      if (error) {
        throw new Error(`ebay_deletion_notification_receipts(mark failed): ${error.message}`);
      }
    },
  };
}

export async function processEbayDeletionReceiptBatch(
  {
    workerId,
    batchSize = DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
    maxAttempts = DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS,
    staleAfterSeconds = DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS,
  }: {
    workerId: string;
    batchSize?: number;
    maxAttempts?: number;
    staleAfterSeconds?: number;
  },
  deps: {
    store?: ReceiptStore;
  } = {},
): Promise<{
  workerId: string;
  claimed: number;
  processed: number;
  succeeded: number;
  failed: number;
  runs: ProcessReceiptRun[];
}> {
  const store = deps.store ?? createDbReceiptStore();
  const safeWorkerId = normalizeWorkerId(workerId);
  const safeBatchSize = clampPositiveInt(batchSize, 1, MAX_EBAY_DELETION_RECEIPT_BATCH_LIMIT);
  const safeMaxAttempts = clampPositiveInt(maxAttempts, 1, 20);
  const safeStaleAfterSeconds = clampPositiveInt(staleAfterSeconds, 60, 86_400);

  const claimed = await store.claimReceipts({
    workerId: safeWorkerId,
    batchSize: safeBatchSize,
    maxAttempts: safeMaxAttempts,
    staleAfterSeconds: safeStaleAfterSeconds,
  });

  const runs: ProcessReceiptRun[] = [];
  for (const receipt of claimed) {
    try {
      const payload = normalizeReceiptPayload(receipt);
      const reviewTask = await store.insertManualReviewTask(deriveTaskInput(receipt, payload));
      const outcome: EbayDeletionReceiptProcessingOutcome = reviewTask.created
        ? "manual_review_task_created"
        : "manual_review_task_existing";

      await store.markReceiptProcessed({
        receiptId: receipt.id,
        workerId: safeWorkerId,
        outcome,
      });

      runs.push({
        receiptId: receipt.id,
        notificationId: receipt.notification_id,
        ok: true,
        status: "processed",
        outcome,
        errorCode: null,
        error: null,
      });
    } catch (error) {
      const errorCode = errorCodeForReceipt(error);
      const errorSummary = summarizeError(error);
      await store.markReceiptFailed({
        receiptId: receipt.id,
        workerId: safeWorkerId,
        errorCode,
        errorSummary,
      });

      runs.push({
        receiptId: receipt.id,
        notificationId: receipt.notification_id,
        ok: false,
        status: "failed",
        outcome: null,
        errorCode,
        error: errorSummary,
      });
    }
  }

  return {
    workerId: safeWorkerId,
    claimed: claimed.length,
    processed: runs.length,
    succeeded: runs.filter((run) => run.ok).length,
    failed: runs.filter((run) => !run.ok).length,
    runs,
  };
}
