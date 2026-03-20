import assert from "node:assert/strict";
import { ADMIN_ROUTES } from "../lib/auth/route-registry.ts";
import {
  EbayDeletionReviewUpdateError,
  getEbayDeletionManualReviewTaskDetail,
  updateEbayDeletionManualReviewTask,
} from "../lib/ebay/deletion-review.ts";
import {
  handleAdminEbayDeletionTaskDetail,
  handleAdminEbayDeletionTaskList,
  handleAdminEbayDeletionTaskPatch,
} from "../lib/ebay/deletion-review-routes.ts";

function authorizedInternalAdmin(overrides = {}) {
  return {
    ok: true,
    session: {
      actorIdentifier: "clerk:user_123",
      clerkUserId: "user_123",
      primaryEmail: "alice@example.com",
      displayName: "Alice Admin",
      issuedAt: "2026-03-18T18:00:00.000Z",
      expiresAt: "2026-03-18T20:00:00.000Z",
      ...overrides,
    },
  };
}

function buildTaskRow(overrides = {}) {
  return {
    id: "task-1",
    receipt_id: "receipt-1",
    notification_id: "notif-123",
    topic: "MARKETPLACE_ACCOUNT_DELETION",
    event_date: "2026-03-18T18:00:00.000Z",
    publish_date: "2026-03-18T18:00:05.000Z",
    ebay_user_id: "ebay-user-123",
    ebay_username: "collector_alpha",
    review_status: "OPEN",
    review_state: "pending_review",
    review_notes: null,
    review_state_updated_at: "2026-03-18T18:05:00.000Z",
    review_state_updated_by: "clerk:user_123",
    candidate_match_clerk_user_id: null,
    candidate_match_handle: null,
    candidate_match_handle_norm: null,
    candidate_match_reason: null,
    candidate_match_marked_at: null,
    candidate_match_marked_by: null,
    created_at: "2026-03-18T18:00:10.000Z",
    reviewed_at: null,
    ...overrides,
  };
}

function buildReceiptRow(overrides = {}) {
  return {
    id: "receipt-1",
    schema_version: "1.0",
    publish_attempt_count: 1,
    payload: {
      metadata: {
        topic: "MARKETPLACE_ACCOUNT_DELETION",
        schemaVersion: "1.0",
      },
      notification: {
        notificationId: "notif-123",
        eventDate: "2026-03-18T18:00:00.000Z",
        publishDate: "2026-03-18T18:00:05.000Z",
        publishAttemptCount: 1,
        data: {
          userId: "ebay-user-123",
          username: "collector_alpha",
          eiasToken: "token-123",
        },
      },
    },
    payload_sha256: "deadbeefcafebabefeedface0123456789abcdef0123456789abcdef01234567",
    signature_alg: "ECDSA",
    signature_digest: "SHA1",
    signature_kid: "kid-123",
    verification_key_alg: "ECDSA",
    verification_key_digest: "SHA1",
    processing_status: "processed",
    processing_outcome: "manual_review_task_created",
    processing_worker: "worker-1",
    attempt_count: 1,
    received_at: "2026-03-18T18:00:10.000Z",
    processed_at: "2026-03-18T18:01:00.000Z",
    failed_at: null,
    last_attempted_at: "2026-03-18T18:01:00.000Z",
    last_error_code: null,
    last_error_summary: null,
    ...overrides,
  };
}

function buildMatchRow(overrides = {}) {
  return {
    clerk_user_id: "user_123",
    handle: "collector_alpha",
    handle_norm: "collector_alpha",
    created_at: "2026-01-01T00:00:00.000Z",
    profile_visibility: "PUBLIC",
    ...overrides,
  };
}

function buildAuditEventRow(overrides = {}) {
  return {
    id: "event-1",
    task_id: "task-1",
    actor_identifier: "clerk:user_123",
    event_type: "review_state_changed",
    prior_review_state: "pending_review",
    new_review_state: "matched_candidate",
    note_payload: null,
    candidate_match_clerk_user_id: null,
    candidate_match_handle: null,
    candidate_match_handle_norm: null,
    candidate_match_reason: null,
    created_at: "2026-03-18T18:10:00.000Z",
    ...overrides,
  };
}

function buildTaskDetail(overrides = {}) {
  return {
    task: {
      id: "task-1",
      receiptId: "receipt-1",
      notificationId: "notif-123",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      eventDate: "2026-03-18T18:00:00.000Z",
      publishDate: "2026-03-18T18:00:05.000Z",
      ebayUserId: "ebay-user-123",
      ebayUsername: "collector_alpha",
      reviewState: "matched_candidate",
      reviewStateUpdatedAt: "2026-03-18T18:10:00.000Z",
      reviewStateUpdatedBy: "clerk:user_123",
      reviewNotes: "Exact handle match; requires later identity confirmation.",
      selectedCandidateMatch: {
        clerkUserId: "user_123",
        handle: "collector_alpha",
        handleNorm: "collector_alpha",
        matchReason: "exact_handle_candidate",
        markedAt: "2026-03-18T18:10:00.000Z",
        markedBy: "clerk:user_123",
      },
      createdAt: "2026-03-18T18:00:10.000Z",
      reviewedAt: "2026-03-18T18:10:00.000Z",
      receipt: {
        processingStatus: "processed",
        processingOutcome: "manual_review_task_created",
        processingWorker: "worker-1",
        attemptCount: 1,
        publishAttemptCount: 1,
        receivedAt: "2026-03-18T18:00:10.000Z",
        processedAt: "2026-03-18T18:01:00.000Z",
        failedAt: null,
        lastAttemptedAt: "2026-03-18T18:01:00.000Z",
        lastErrorCode: null,
        lastErrorSummary: null,
        signature: {
          kid: "kid-123",
          algorithm: "ECDSA",
          digest: "SHA1",
          verificationKeyAlgorithm: "ECDSA",
          verificationKeyDigest: "SHA1",
        },
        verifiedPayload: {
          schemaVersion: "1.0",
          hasEiasToken: true,
          payloadSha256Prefix: "deadbeefcafebabe",
        },
      },
      advisoryMatches: {
        ebayUsername: "collector_alpha",
        candidateHandleNorms: ["collector_alpha", "collectoralpha"],
        exactAppUserMatches: [
          {
            clerkUserId: "user_123",
            handle: "collector_alpha",
            handleNorm: "collector_alpha",
            createdAt: "2026-01-01T00:00:00.000Z",
            profileVisibility: "PUBLIC",
            matchReason: "exact_handle_candidate",
          },
        ],
        note: "Advisory exact-handle candidates only.",
      },
    },
    auditEvents: [
      {
        id: "event-3",
        taskId: "task-1",
        actorIdentifier: "clerk:user_123",
        eventType: "candidate_match_marked",
        priorReviewState: "pending_review",
        newReviewState: "matched_candidate",
        notePayload: null,
        candidateMatch: {
          clerkUserId: "user_123",
          handle: "collector_alpha",
          handleNorm: "collector_alpha",
          reason: "exact_handle_candidate",
        },
        createdAt: "2026-03-18T18:10:02.000Z",
      },
      {
        id: "event-2",
        taskId: "task-1",
        actorIdentifier: "clerk:user_123",
        eventType: "review_note_added",
        priorReviewState: "pending_review",
        newReviewState: "matched_candidate",
        notePayload: "Exact handle match; requires later identity confirmation.",
        candidateMatch: null,
        createdAt: "2026-03-18T18:10:01.000Z",
      },
      {
        id: "event-1",
        taskId: "task-1",
        actorIdentifier: "clerk:user_123",
        eventType: "review_state_changed",
        priorReviewState: "pending_review",
        newReviewState: "matched_candidate",
        notePayload: null,
        candidateMatch: null,
        createdAt: "2026-03-18T18:10:00.000Z",
      },
    ],
    ...overrides,
  };
}

export async function runEbayDeletionReviewTests() {
  {
    const unauthorized = await handleAdminEbayDeletionTaskList(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks"),
      {
        requireInternalAdminFn: async () => ({
          ok: false,
          response: new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        }),
      },
    );
    assert.equal(unauthorized.status, 401);
  }

  {
    const forbidden = await handleAdminEbayDeletionTaskList(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks"),
      {
        requireInternalAdminFn: async () => ({
          ok: false,
          response: new Response(JSON.stringify({ ok: false, error: "Forbidden", code: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        }),
      },
    );
    assert.equal(forbidden.status, 403);
  }

  {
    const response = await handleAdminEbayDeletionTaskList(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks?reviewState=pending_review&limit=5"),
      {
        requireInternalAdminFn: async () => authorizedInternalAdmin(),
        listTasks: async () => ({
          summary: {
            total: 1,
            byReviewState: {
              pending_review: 1,
              needs_more_context: 0,
              matched_candidate: 0,
              no_match_found: 0,
              escalated: 0,
            },
          },
          tasks: [buildTaskDetail().task],
        }),
      },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.tasks.length, 1);
    assert.equal(json.tasks[0].selectedCandidateMatch.handle, "collector_alpha");
    assert.equal("payload" in json.tasks[0], false);
  }

  {
    const response = await handleAdminEbayDeletionTaskDetail(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks/task-1"),
      { params: Promise.resolve({ id: "task-1" }) },
      {
        requireInternalAdminFn: async () => authorizedInternalAdmin(),
        getTaskDetail: async () => buildTaskDetail(),
      },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.task.notificationId, "notif-123");
    assert.equal(json.auditEvents.length, 3);
    assert.equal(json.auditEvents[0].eventType, "candidate_match_marked");
  }

  {
    let called = false;
    const response = await handleAdminEbayDeletionTaskPatch(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks/task-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationId: "mutate-me" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
      {
        requireInternalAdminFn: async () => authorizedInternalAdmin(),
        updateTask: async () => {
          called = true;
          return buildTaskDetail();
        },
      },
    );
    assert.equal(response.status, 400);
    assert.equal(called, false);
  }

  {
    const response = await handleAdminEbayDeletionTaskPatch(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks/task-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-operator-id": "clerk:user_999",
        },
        body: JSON.stringify({
          reviewState: "matched_candidate",
          reviewNotes: "Exact handle match; requires later identity confirmation.",
          candidateMatch: {
            clerkUserId: "user_123",
            handleNorm: "collector_alpha",
          },
        }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
      {
        requireInternalAdminFn: async () => authorizedInternalAdmin(),
        updateTask: async (input) => {
          assert.equal(input.reviewer, "clerk:user_123");
          assert.equal(input.reviewState, "matched_candidate");
          assert.deepEqual(input.candidateMatch, {
            clerkUserId: "user_123",
            handleNorm: "collector_alpha",
          });
          return buildTaskDetail();
        },
      },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.task.reviewState, "matched_candidate");
    assert.equal(json.auditEvents.some((event) => event.eventType === "review_state_changed"), true);
    assert.equal(json.auditEvents.some((event) => event.eventType === "review_note_added"), true);
    assert.equal(json.auditEvents.some((event) => event.eventType === "candidate_match_marked"), true);
  }

  {
    const response = await handleAdminEbayDeletionTaskPatch(
      new Request("https://popalpha.app/api/admin/ebay-deletion-tasks/task-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-operator-id": "alice@example.com",
        },
        body: JSON.stringify({
          reviewState: "needs_more_context",
        }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
      {
        requireInternalAdminFn: async () => authorizedInternalAdmin(),
        updateTask: async (input) => {
          assert.equal(input.reviewer, "clerk:user_123");
          return buildTaskDetail({
            task: {
              ...buildTaskDetail().task,
              reviewState: "needs_more_context",
              reviewStateUpdatedBy: "clerk:user_123",
            },
          });
        },
      },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.task.reviewStateUpdatedBy, "clerk:user_123");
  }

  {
    const detail = await getEbayDeletionManualReviewTaskDetail("task-1", {
      store: {
        async listTasks() {
          throw new Error("listTasks should not run");
        },
        async getTask() {
          return buildTaskRow();
        },
        async countTasks() {
          return 0;
        },
        async countTasksByReviewState() {
          return 0;
        },
        async listReceiptsByIds() {
          return [buildReceiptRow()];
        },
        async listAppUserMatches() {
          return [buildMatchRow()];
        },
        async listAuditEvents() {
          return [
            buildAuditEventRow(),
            buildAuditEventRow({
              id: "event-2",
              event_type: "review_note_added",
              note_payload: "Needs later legal review.",
            }),
          ];
        },
        async applyTaskUpdate() {
          throw new Error("applyTaskUpdate should not run");
        },
      },
    });
    assert.equal(detail?.auditEvents.length, 2);
    assert.equal(detail?.task.advisoryMatches.exactAppUserMatches[0].handle, "collector_alpha");
  }

  {
    const applyCalls = [];
    const detail = await updateEbayDeletionManualReviewTask(
      {
        taskId: "task-1",
        reviewState: "matched_candidate",
        reviewNotes: "Exact handle match; requires later identity confirmation.",
        setReviewNotes: true,
        candidateMatch: {
          clerkUserId: "user_123",
          handleNorm: "collector_alpha",
        },
        reviewer: "clerk:user_123",
      },
      {
        store: {
          async listTasks() {
            throw new Error("listTasks should not run");
          },
          async getTask() {
            return buildTaskRow();
          },
          async countTasks() {
            return 0;
          },
          async countTasksByReviewState() {
            return 0;
          },
          async listReceiptsByIds() {
            return [buildReceiptRow()];
          },
          async listAppUserMatches() {
            return [buildMatchRow()];
          },
          async listAuditEvents() {
            return [
              buildAuditEventRow(),
              buildAuditEventRow({
                id: "event-2",
                event_type: "review_note_added",
                note_payload: "Exact handle match; requires later identity confirmation.",
              }),
              buildAuditEventRow({
                id: "event-3",
                event_type: "candidate_match_marked",
                candidate_match_clerk_user_id: "user_123",
                candidate_match_handle: "collector_alpha",
                candidate_match_handle_norm: "collector_alpha",
                candidate_match_reason: "exact_handle_candidate",
              }),
            ];
          },
          async applyTaskUpdate(input) {
            applyCalls.push(input);
            return buildTaskRow({
              review_status: "REVIEWED",
              review_state: "matched_candidate",
              review_notes: "Exact handle match; requires later identity confirmation.",
              review_state_updated_at: "2026-03-18T18:10:00.000Z",
              review_state_updated_by: "clerk:user_123",
              candidate_match_clerk_user_id: "user_123",
              candidate_match_handle: "collector_alpha",
              candidate_match_handle_norm: "collector_alpha",
              candidate_match_reason: "exact_handle_candidate",
              candidate_match_marked_at: "2026-03-18T18:10:02.000Z",
              candidate_match_marked_by: "clerk:user_123",
              reviewed_at: "2026-03-18T18:10:02.000Z",
            });
          },
        },
      },
    );
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].candidateMatch.handle, "collector_alpha");
    assert.equal(applyCalls[0].candidateMatch.matchReason, "exact_handle_candidate");
    assert.equal(detail?.task.selectedCandidateMatch?.handleNorm, "collector_alpha");
    assert.equal(detail?.auditEvents.length, 3);
  }

  {
    await assert.rejects(
      () =>
        updateEbayDeletionManualReviewTask(
          {
            taskId: "task-1",
            setReviewNotes: false,
            candidateMatch: {
              clerkUserId: "user_999",
              handleNorm: "not_a_real_candidate",
            },
            reviewer: "clerk:user_123",
          },
          {
            store: {
              async listTasks() {
                throw new Error("listTasks should not run");
              },
              async getTask() {
                return buildTaskRow();
              },
              async countTasks() {
                return 0;
              },
              async countTasksByReviewState() {
                return 0;
              },
              async listReceiptsByIds() {
                return [buildReceiptRow()];
              },
              async listAppUserMatches() {
                return [buildMatchRow()];
              },
              async listAuditEvents() {
                return [];
              },
              async applyTaskUpdate() {
                throw new Error("applyTaskUpdate should not run for invalid candidate");
              },
            },
          },
        ),
      (error) =>
        error instanceof EbayDeletionReviewUpdateError
        && error.code === "INVALID_CANDIDATE_MATCH"
        && error.status === 409,
    );
  }

  assert.equal(ADMIN_ROUTES.includes("admin/ebay-deletion-tasks"), true);
  assert.equal(ADMIN_ROUTES.includes("admin/ebay-deletion-tasks/[id]"), true);
}
