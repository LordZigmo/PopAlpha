import assert from "node:assert/strict";
import { CRON_ROUTES } from "../lib/auth/route-registry.ts";
import {
  DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
  DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS,
  DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS,
  processEbayDeletionReceiptBatch,
} from "../lib/ebay/deletion-receipt-processor.ts";

function buildReceipt(overrides = {}) {
  return {
    id: "receipt-1",
    notification_id: "notif-123",
    topic: "MARKETPLACE_ACCOUNT_DELETION",
    schema_version: "1.0",
    publish_attempt_count: 1,
    payload: {
      metadata: {
        topic: "MARKETPLACE_ACCOUNT_DELETION",
        schemaVersion: "1.0",
      },
      notification: {
        notificationId: "notif-123",
        eventDate: "2026-03-18T16:20:00.000Z",
        publishDate: "2026-03-18T16:20:05.000Z",
        publishAttemptCount: 1,
        data: {
          userId: "ebay-user-123",
          username: "collector_alpha",
          eiasToken: "eias-token-abc",
        },
      },
    },
    processing_status: "processing",
    processing_worker: "worker-1",
    attempt_count: 1,
    received_at: "2026-03-18T16:21:00.000Z",
    ...overrides,
  };
}

export async function runEbayDeletionReceiptProcessorTests() {
  {
    const calls = {
      claim: [],
      insert: [],
      processed: [],
      failed: [],
    };
    const result = await processEbayDeletionReceiptBatch(
      { workerId: "worker-1" },
      {
        store: {
          async claimReceipts(input) {
            calls.claim.push(input);
            return [buildReceipt()];
          },
          async insertManualReviewTask(input) {
            calls.insert.push(input);
            return { created: true };
          },
          async markReceiptProcessed(input) {
            calls.processed.push(input);
          },
          async markReceiptFailed(input) {
            calls.failed.push(input);
          },
        },
      },
    );

    assert.equal(calls.claim.length, 1);
    assert.deepEqual(calls.claim[0], {
      workerId: "worker-1",
      batchSize: DEFAULT_EBAY_DELETION_RECEIPT_BATCH_LIMIT,
      maxAttempts: DEFAULT_EBAY_DELETION_RECEIPT_MAX_ATTEMPTS,
      staleAfterSeconds: DEFAULT_EBAY_DELETION_RECEIPT_STALE_AFTER_SECONDS,
    });
    assert.equal(calls.insert.length, 1);
    assert.equal(calls.insert[0].receiptId, "receipt-1");
    assert.equal(calls.insert[0].notificationId, "notif-123");
    assert.equal(calls.processed.length, 1);
    assert.equal(calls.processed[0].outcome, "manual_review_task_created");
    assert.equal(calls.failed.length, 0);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.runs[0].status, "processed");
    assert.equal(result.runs[0].outcome, "manual_review_task_created");
  }

  {
    const processed = [];
    const result = await processEbayDeletionReceiptBatch(
      { workerId: "worker-2", batchSize: 1 },
      {
        store: {
          async claimReceipts() {
            return [buildReceipt({
              id: "receipt-2",
              notification_id: "notif-456",
              processing_worker: "worker-2",
              payload: {
                metadata: {
                  topic: "MARKETPLACE_ACCOUNT_DELETION",
                  schemaVersion: "1.0",
                },
                notification: {
                  notificationId: "notif-456",
                  eventDate: "2026-03-18T16:20:00.000Z",
                  publishDate: "2026-03-18T16:20:05.000Z",
                  publishAttemptCount: 1,
                  data: {
                    userId: "ebay-user-456",
                    username: "collector_beta",
                    eiasToken: "eias-token-def",
                  },
                },
              },
            })];
          },
          async insertManualReviewTask() {
            return { created: false };
          },
          async markReceiptProcessed(input) {
            processed.push(input);
          },
          async markReceiptFailed() {
            throw new Error("mark failed should not run");
          },
        },
      },
    );

    assert.equal(processed[0].outcome, "manual_review_task_existing");
    assert.equal(result.runs[0].outcome, "manual_review_task_existing");
    assert.equal(result.succeeded, 1);
  }

  {
    const failed = [];
    const result = await processEbayDeletionReceiptBatch(
      { workerId: "worker-3", batchSize: 1 },
      {
        store: {
          async claimReceipts() {
            return [buildReceipt({
              id: "receipt-3",
              notification_id: "notif-789",
              processing_worker: "worker-3",
              payload: {
                metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0" },
                notification: {
                  notificationId: "different-id",
                  eventDate: "2026-03-18T16:20:00.000Z",
                  publishDate: "2026-03-18T16:20:05.000Z",
                  publishAttemptCount: 1,
                  data: { userId: "ebay-user-123", username: "collector_alpha", eiasToken: null },
                },
              },
            })];
          },
          async insertManualReviewTask() {
            throw new Error("insert should not run for invalid payload");
          },
          async markReceiptProcessed() {
            throw new Error("mark processed should not run");
          },
          async markReceiptFailed(input) {
            failed.push(input);
          },
        },
      },
    );

    assert.equal(failed.length, 1);
    assert.equal(failed[0].receiptId, "receipt-3");
    assert.match(failed[0].errorSummary, /notification_id does not match/i);
    assert.equal(result.failed, 1);
    assert.equal(result.runs[0].status, "failed");
  }

  assert.equal(CRON_ROUTES.includes("cron/process-ebay-deletion-receipts"), true);
}
