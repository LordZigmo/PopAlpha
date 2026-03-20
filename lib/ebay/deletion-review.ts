import { parseEbayDeletionNotificationPayloadValue } from "@/lib/ebay/deletion-notification";
import { validateHandle } from "@/lib/handles";

export const EBAY_DELETION_MANUAL_REVIEW_STATES = [
  "pending_review",
  "needs_more_context",
  "matched_candidate",
  "no_match_found",
  "escalated",
] as const;

export const EBAY_DELETION_MANUAL_REVIEW_EVENT_TYPES = [
  "review_state_changed",
  "review_note_added",
  "review_note_cleared",
  "candidate_match_marked",
  "candidate_match_cleared",
  "escalated",
] as const;

export type EbayDeletionManualReviewState = (typeof EBAY_DELETION_MANUAL_REVIEW_STATES)[number];
export type EbayDeletionManualReviewEventType = (typeof EBAY_DELETION_MANUAL_REVIEW_EVENT_TYPES)[number];

type ReceiptProcessingStatus = "received" | "processing" | "processed" | "failed";
type ReceiptProcessingOutcome = "manual_review_task_created" | "manual_review_task_existing" | null;
type LegacyReviewStatus = "OPEN" | "REVIEWED" | "DISMISSED";

type ManualReviewTaskRow = {
  id: string;
  receipt_id: string;
  notification_id: string;
  topic: string;
  event_date: string;
  publish_date: string;
  ebay_user_id: string;
  ebay_username: string | null;
  review_status: LegacyReviewStatus;
  review_state: EbayDeletionManualReviewState;
  review_notes: string | null;
  review_state_updated_at: string;
  review_state_updated_by: string | null;
  candidate_match_clerk_user_id: string | null;
  candidate_match_handle: string | null;
  candidate_match_handle_norm: string | null;
  candidate_match_reason: string | null;
  candidate_match_marked_at: string | null;
  candidate_match_marked_by: string | null;
  created_at: string;
  reviewed_at: string | null;
};

type ReceiptRow = {
  id: string;
  schema_version: string;
  publish_attempt_count: number;
  payload: unknown;
  payload_sha256: string;
  signature_alg: string;
  signature_digest: string;
  signature_kid: string;
  verification_key_alg: string;
  verification_key_digest: string;
  processing_status: ReceiptProcessingStatus;
  processing_outcome: ReceiptProcessingOutcome;
  processing_worker: string | null;
  attempt_count: number;
  received_at: string;
  processed_at: string | null;
  failed_at: string | null;
  last_attempted_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
};

type ReviewAuditEventRow = {
  id: string;
  task_id: string;
  actor_identifier: string;
  event_type: EbayDeletionManualReviewEventType;
  prior_review_state: EbayDeletionManualReviewState | null;
  new_review_state: EbayDeletionManualReviewState | null;
  note_payload: string | null;
  candidate_match_clerk_user_id: string | null;
  candidate_match_handle: string | null;
  candidate_match_handle_norm: string | null;
  candidate_match_reason: string | null;
  created_at: string;
};

type AppUserMatchRow = {
  clerk_user_id: string;
  handle: string | null;
  handle_norm: string | null;
  created_at: string;
  profile_visibility: "PUBLIC" | "PRIVATE";
};

export type EbayDeletionReviewAdvisoryMatch = {
  clerkUserId: string;
  handle: string;
  handleNorm: string;
  createdAt: string;
  profileVisibility: "PUBLIC" | "PRIVATE";
  matchReason: "exact_handle_candidate";
};

export type EbayDeletionSelectedCandidateMatch = {
  clerkUserId: string;
  handle: string;
  handleNorm: string;
  matchReason: string;
  markedAt: string | null;
  markedBy: string | null;
} | null;

export type EbayDeletionReviewAuditEventView = {
  id: string;
  taskId: string;
  actorIdentifier: string;
  eventType: EbayDeletionManualReviewEventType;
  priorReviewState: EbayDeletionManualReviewState | null;
  newReviewState: EbayDeletionManualReviewState | null;
  notePayload: string | null;
  candidateMatch: {
    clerkUserId: string | null;
    handle: string | null;
    handleNorm: string | null;
    reason: string | null;
  } | null;
  createdAt: string;
};

export type EbayDeletionReviewTaskView = {
  id: string;
  receiptId: string;
  notificationId: string;
  topic: string;
  eventDate: string;
  publishDate: string;
  ebayUserId: string;
  ebayUsername: string | null;
  reviewState: EbayDeletionManualReviewState;
  reviewStateUpdatedAt: string;
  reviewStateUpdatedBy: string | null;
  reviewNotes: string | null;
  selectedCandidateMatch: EbayDeletionSelectedCandidateMatch;
  createdAt: string;
  reviewedAt: string | null;
  receipt: {
    processingStatus: ReceiptProcessingStatus;
    processingOutcome: ReceiptProcessingOutcome;
    processingWorker: string | null;
    attemptCount: number;
    publishAttemptCount: number;
    receivedAt: string;
    processedAt: string | null;
    failedAt: string | null;
    lastAttemptedAt: string | null;
    lastErrorCode: string | null;
    lastErrorSummary: string | null;
    signature: {
      kid: string;
      algorithm: string;
      digest: string;
      verificationKeyAlgorithm: string;
      verificationKeyDigest: string;
    };
    verifiedPayload: {
      schemaVersion: string;
      hasEiasToken: boolean | null;
      payloadSha256Prefix: string;
    };
  } | null;
  advisoryMatches: {
    ebayUsername: string | null;
    candidateHandleNorms: string[];
    exactAppUserMatches: EbayDeletionReviewAdvisoryMatch[];
    note: string;
  };
};

export type EbayDeletionReviewTaskDetailView = {
  task: EbayDeletionReviewTaskView;
  auditEvents: EbayDeletionReviewAuditEventView[];
};

type ReviewStore = {
  listTasks(input: {
    limit: number;
    reviewState?: EbayDeletionManualReviewState;
    notificationId?: string;
  }): Promise<ManualReviewTaskRow[]>;
  getTask(taskId: string): Promise<ManualReviewTaskRow | null>;
  countTasks(): Promise<number>;
  countTasksByReviewState(reviewState: EbayDeletionManualReviewState): Promise<number>;
  listReceiptsByIds(receiptIds: string[]): Promise<ReceiptRow[]>;
  listAppUserMatches(handleNorms: string[]): Promise<AppUserMatchRow[]>;
  listAuditEvents(taskId: string): Promise<ReviewAuditEventRow[]>;
  applyTaskUpdate(input: {
    taskId: string;
    reviewState?: EbayDeletionManualReviewState;
    setReviewNotes: boolean;
    reviewNotes?: string | null;
    candidateMatch?: {
      clerkUserId: string;
      handle: string;
      handleNorm: string;
      matchReason: string;
    } | null;
    clearCandidateMatch: boolean;
    reviewer: string;
  }): Promise<ManualReviewTaskRow | null>;
};

type ReviewServiceDependencies = {
  store?: ReviewStore;
};

type RequestedCandidateMatch = {
  clerkUserId: string;
  handleNorm: string;
};

export class EbayDeletionReviewUpdateError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_ERROR_SUMMARY_LENGTH = 280;

function truncateText(value: string | null, limit: number): string | null {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function clampListLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit as number), MAX_LIST_LIMIT));
}

function legacyReviewStatusForState(reviewState: EbayDeletionManualReviewState): LegacyReviewStatus {
  switch (reviewState) {
    case "matched_candidate":
      return "REVIEWED";
    case "no_match_found":
      return "DISMISSED";
    default:
      return "OPEN";
  }
}

export function isEbayDeletionManualReviewState(value: string): value is EbayDeletionManualReviewState {
  return (EBAY_DELETION_MANUAL_REVIEW_STATES as readonly string[]).includes(value);
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function deriveHandleCandidates(username: string | null): string[] {
  const raw = normalizeText(username).toLowerCase();
  if (!raw) return [];

  const candidates = new Set<string>();
  const sanitized = raw
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const compact = raw.replace(/[^a-z0-9]+/g, "");

  for (const candidate of [raw, sanitized, compact]) {
    const result = validateHandle(candidate);
    if (result.valid) {
      candidates.add(result.normalized);
    }
  }

  return [...candidates];
}

function summarizeVerifiedPayload(payload: unknown): {
  schemaVersion: string;
  hasEiasToken: boolean | null;
} {
  try {
    const parsed = parseEbayDeletionNotificationPayloadValue(payload);
    return {
      schemaVersion: parsed.metadata.schemaVersion,
      hasEiasToken: Boolean(parsed.notification.data.eiasToken),
    };
  } catch {
    return {
      schemaVersion: "unknown",
      hasEiasToken: null,
    };
  }
}

function buildSelectedCandidateMatch(task: ManualReviewTaskRow): EbayDeletionSelectedCandidateMatch {
  if (!task.candidate_match_clerk_user_id || !task.candidate_match_handle || !task.candidate_match_handle_norm) {
    return null;
  }

  return {
    clerkUserId: task.candidate_match_clerk_user_id,
    handle: task.candidate_match_handle,
    handleNorm: task.candidate_match_handle_norm,
    matchReason: task.candidate_match_reason ?? "exact_handle_candidate",
    markedAt: task.candidate_match_marked_at,
    markedBy: task.candidate_match_marked_by,
  };
}

function buildAdvisoryMatches(
  task: Pick<ManualReviewTaskRow, "ebay_username">,
  matchesByHandleNorm: Map<string, AppUserMatchRow[]>,
): EbayDeletionReviewTaskView["advisoryMatches"] {
  const candidateHandleNorms = deriveHandleCandidates(task.ebay_username);
  const exactAppUserMatches: EbayDeletionReviewAdvisoryMatch[] = [];

  for (const candidate of candidateHandleNorms) {
    for (const match of matchesByHandleNorm.get(candidate) ?? []) {
      if (!match.handle || !match.handle_norm) continue;
      exactAppUserMatches.push({
        clerkUserId: match.clerk_user_id,
        handle: match.handle,
        handleNorm: match.handle_norm,
        createdAt: match.created_at,
        profileVisibility: match.profile_visibility,
        matchReason: "exact_handle_candidate",
      });
    }
  }

  const note = !task.ebay_username
    ? "Verified receipt has no username, so no handle-based PopAlpha match can be suggested."
    : exactAppUserMatches.length > 0
      ? "Advisory exact-handle candidates only. Identity resolution still requires manual review before any deletion workflow exists."
      : "No exact PopAlpha handle matched the normalized eBay username candidates. This is advisory only and does not imply no user match exists.";

  return {
    ebayUsername: task.ebay_username,
    candidateHandleNorms,
    exactAppUserMatches,
    note,
  };
}

function buildAuditEventView(event: ReviewAuditEventRow): EbayDeletionReviewAuditEventView {
  return {
    id: event.id,
    taskId: event.task_id,
    actorIdentifier: event.actor_identifier,
    eventType: event.event_type,
    priorReviewState: event.prior_review_state,
    newReviewState: event.new_review_state,
    notePayload: event.note_payload,
    candidateMatch:
      event.candidate_match_clerk_user_id
      || event.candidate_match_handle
      || event.candidate_match_handle_norm
      || event.candidate_match_reason
        ? {
            clerkUserId: event.candidate_match_clerk_user_id,
            handle: event.candidate_match_handle,
            handleNorm: event.candidate_match_handle_norm,
            reason: event.candidate_match_reason,
          }
        : null,
    createdAt: event.created_at,
  };
}

function buildTaskView(
  task: ManualReviewTaskRow,
  receipt: ReceiptRow | null,
  matchesByHandleNorm: Map<string, AppUserMatchRow[]>,
): EbayDeletionReviewTaskView {
  const advisoryMatches = buildAdvisoryMatches(task, matchesByHandleNorm);
  const payloadSummary = receipt ? summarizeVerifiedPayload(receipt.payload) : null;

  return {
    id: task.id,
    receiptId: task.receipt_id,
    notificationId: task.notification_id,
    topic: task.topic,
    eventDate: task.event_date,
    publishDate: task.publish_date,
    ebayUserId: task.ebay_user_id,
    ebayUsername: task.ebay_username,
    reviewState: task.review_state,
    reviewStateUpdatedAt: task.review_state_updated_at,
    reviewStateUpdatedBy: task.review_state_updated_by,
    reviewNotes: task.review_notes,
    selectedCandidateMatch: buildSelectedCandidateMatch(task),
    createdAt: task.created_at,
    reviewedAt: task.reviewed_at,
    receipt: receipt
      ? {
          processingStatus: receipt.processing_status,
          processingOutcome: receipt.processing_outcome,
          processingWorker: receipt.processing_worker,
          attemptCount: receipt.attempt_count,
          publishAttemptCount: receipt.publish_attempt_count,
          receivedAt: receipt.received_at,
          processedAt: receipt.processed_at,
          failedAt: receipt.failed_at,
          lastAttemptedAt: receipt.last_attempted_at,
          lastErrorCode: receipt.last_error_code,
          lastErrorSummary: truncateText(receipt.last_error_summary, MAX_ERROR_SUMMARY_LENGTH),
          signature: {
            kid: receipt.signature_kid,
            algorithm: receipt.signature_alg,
            digest: receipt.signature_digest,
            verificationKeyAlgorithm: receipt.verification_key_alg,
            verificationKeyDigest: receipt.verification_key_digest,
          },
          verifiedPayload: {
            schemaVersion: payloadSummary?.schemaVersion ?? "unknown",
            hasEiasToken: payloadSummary?.hasEiasToken ?? null,
            payloadSha256Prefix: receipt.payload_sha256.slice(0, 16),
          },
        }
      : null,
    advisoryMatches,
  };
}

async function getAdminSupabase() {
  const { dbAdmin: createAdminSupabase } = await import("@/lib/db/admin");
  return createAdminSupabase();
}

function createDbReviewStore(): ReviewStore {
  return {
    async listTasks({ limit, reviewState, notificationId }) {
      const supabase = await getAdminSupabase();
      let query = supabase
        .from("ebay_deletion_manual_review_tasks")
        .select(
          "id, receipt_id, notification_id, topic, event_date, publish_date, ebay_user_id, ebay_username, review_status, review_state, review_notes, review_state_updated_at, review_state_updated_by, candidate_match_clerk_user_id, candidate_match_handle, candidate_match_handle_norm, candidate_match_reason, candidate_match_marked_at, candidate_match_marked_by, created_at, reviewed_at",
        )
        .order("created_at", { ascending: false })
        .limit(limit);

      if (reviewState) {
        query = query.eq("review_state", reviewState);
      }
      if (notificationId) {
        query = query.eq("notification_id", notificationId);
      }

      const { data, error } = await query;
      if (error) {
        throw new Error(`ebay_deletion_manual_review_tasks(list): ${error.message}`);
      }
      return (data ?? []) as ManualReviewTaskRow[];
    },
    async getTask(taskId) {
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase
        .from("ebay_deletion_manual_review_tasks")
        .select(
          "id, receipt_id, notification_id, topic, event_date, publish_date, ebay_user_id, ebay_username, review_status, review_state, review_notes, review_state_updated_at, review_state_updated_by, candidate_match_clerk_user_id, candidate_match_handle, candidate_match_handle_norm, candidate_match_reason, candidate_match_marked_at, candidate_match_marked_by, created_at, reviewed_at",
        )
        .eq("id", taskId)
        .maybeSingle();

      if (error) {
        throw new Error(`ebay_deletion_manual_review_tasks(get): ${error.message}`);
      }
      return (data ?? null) as ManualReviewTaskRow | null;
    },
    async countTasks() {
      const supabase = await getAdminSupabase();
      const { count, error } = await supabase
        .from("ebay_deletion_manual_review_tasks")
        .select("*", { count: "exact", head: true });
      if (error) {
        throw new Error(`ebay_deletion_manual_review_tasks(count): ${error.message}`);
      }
      return count ?? 0;
    },
    async countTasksByReviewState(reviewState) {
      const supabase = await getAdminSupabase();
      const { count, error } = await supabase
        .from("ebay_deletion_manual_review_tasks")
        .select("*", { count: "exact", head: true })
        .eq("review_state", reviewState);
      if (error) {
        throw new Error(`ebay_deletion_manual_review_tasks(count ${reviewState}): ${error.message}`);
      }
      return count ?? 0;
    },
    async listReceiptsByIds(receiptIds) {
      if (receiptIds.length === 0) return [];
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase
        .from("ebay_deletion_notification_receipts")
        .select(
          "id, schema_version, publish_attempt_count, payload, payload_sha256, signature_alg, signature_digest, signature_kid, verification_key_alg, verification_key_digest, processing_status, processing_outcome, processing_worker, attempt_count, received_at, processed_at, failed_at, last_attempted_at, last_error_code, last_error_summary",
        )
        .in("id", receiptIds);

      if (error) {
        throw new Error(`ebay_deletion_notification_receipts(list): ${error.message}`);
      }
      return (data ?? []) as ReceiptRow[];
    },
    async listAppUserMatches(handleNorms) {
      if (handleNorms.length === 0) return [];
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase
        .from("app_users")
        .select("clerk_user_id, handle, handle_norm, created_at, profile_visibility")
        .in("handle_norm", handleNorms);

      if (error) {
        throw new Error(`app_users(match lookup): ${error.message}`);
      }
      return (data ?? []) as AppUserMatchRow[];
    },
    async listAuditEvents(taskId) {
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase
        .from("ebay_deletion_manual_review_events")
        .select(
          "id, task_id, actor_identifier, event_type, prior_review_state, new_review_state, note_payload, candidate_match_clerk_user_id, candidate_match_handle, candidate_match_handle_norm, candidate_match_reason, created_at",
        )
        .eq("task_id", taskId)
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(`ebay_deletion_manual_review_events(list): ${error.message}`);
      }
      return (data ?? []) as ReviewAuditEventRow[];
    },
    async applyTaskUpdate({
      taskId,
      reviewState,
      setReviewNotes,
      reviewNotes,
      candidateMatch,
      clearCandidateMatch,
      reviewer,
    }) {
      const supabase = await getAdminSupabase();
      const { data, error } = await supabase.rpc("apply_ebay_deletion_manual_review_update", {
        p_task_id: taskId,
        p_actor_identifier: reviewer,
        p_review_state: reviewState ?? null,
        p_set_review_notes: setReviewNotes,
        p_review_notes: reviewNotes ?? null,
        p_candidate_match_clerk_user_id: candidateMatch?.clerkUserId ?? null,
        p_candidate_match_handle: candidateMatch?.handle ?? null,
        p_candidate_match_handle_norm: candidateMatch?.handleNorm ?? null,
        p_candidate_match_reason: candidateMatch?.matchReason ?? null,
        p_clear_candidate_match: clearCandidateMatch,
      });

      if (error) {
        throw new Error(`apply_ebay_deletion_manual_review_update: ${error.message}`);
      }

      if (!data) return null;
      if (Array.isArray(data)) {
        return (data[0] ?? null) as ManualReviewTaskRow | null;
      }
      return data as ManualReviewTaskRow;
    },
  };
}

function groupMatchesByHandleNorm(matches: AppUserMatchRow[]): Map<string, AppUserMatchRow[]> {
  const grouped = new Map<string, AppUserMatchRow[]>();
  for (const match of matches) {
    if (!match.handle_norm) continue;
    const current = grouped.get(match.handle_norm) ?? [];
    current.push(match);
    grouped.set(match.handle_norm, current);
  }
  return grouped;
}

function collectHandleNorms(tasks: Pick<ManualReviewTaskRow, "ebay_username">[]): string[] {
  const values = new Set<string>();
  for (const task of tasks) {
    for (const candidate of deriveHandleCandidates(task.ebay_username)) {
      values.add(candidate);
    }
  }
  return [...values];
}

function buildDetailView(
  task: ManualReviewTaskRow,
  receipt: ReceiptRow | null,
  matchesByHandleNorm: Map<string, AppUserMatchRow[]>,
  auditEvents: ReviewAuditEventRow[],
): EbayDeletionReviewTaskDetailView {
  return {
    task: buildTaskView(task, receipt, matchesByHandleNorm),
    auditEvents: auditEvents.map(buildAuditEventView),
  };
}

function resolveRequestedCandidateMatch(
  task: ManualReviewTaskRow,
  matchesByHandleNorm: Map<string, AppUserMatchRow[]>,
  requested: RequestedCandidateMatch,
): {
  clerkUserId: string;
  handle: string;
  handleNorm: string;
  matchReason: string;
} {
  const advisoryMatches = buildAdvisoryMatches(task, matchesByHandleNorm).exactAppUserMatches;
  const selected = advisoryMatches.find(
    (match) =>
      match.clerkUserId === requested.clerkUserId
      && match.handleNorm === requested.handleNorm,
  );

  if (!selected) {
    throw new EbayDeletionReviewUpdateError(
      "INVALID_CANDIDATE_MATCH",
      409,
      "candidateMatch must be chosen from the current advisory exactAppUserMatches for this task.",
    );
  }

  return {
    clerkUserId: selected.clerkUserId,
    handle: selected.handle,
    handleNorm: selected.handleNorm,
    matchReason: selected.matchReason,
  };
}

export async function listEbayDeletionManualReviewTasks(
  filters: {
    limit?: number;
    reviewState?: EbayDeletionManualReviewState;
    notificationId?: string;
  } = {},
  deps: ReviewServiceDependencies = {},
): Promise<{
  summary: {
    total: number;
    byReviewState: Record<EbayDeletionManualReviewState, number>;
  };
  tasks: EbayDeletionReviewTaskView[];
}> {
  const store = deps.store ?? createDbReviewStore();
  const tasks = await store.listTasks({
    limit: clampListLimit(filters.limit),
    reviewState: filters.reviewState,
    notificationId: normalizeText(filters.notificationId) || undefined,
  });

  const [total, ...counts] = await Promise.all([
    store.countTasks(),
    ...EBAY_DELETION_MANUAL_REVIEW_STATES.map((reviewState) => store.countTasksByReviewState(reviewState)),
  ]);

  const receipts = await store.listReceiptsByIds(tasks.map((task) => task.receipt_id));
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const matches = await store.listAppUserMatches(collectHandleNorms(tasks));
  const matchesByHandleNorm = groupMatchesByHandleNorm(matches);

  return {
    summary: {
      total,
      byReviewState: Object.fromEntries(
        EBAY_DELETION_MANUAL_REVIEW_STATES.map((reviewState, index) => [reviewState, counts[index] ?? 0]),
      ) as Record<EbayDeletionManualReviewState, number>,
    },
    tasks: tasks.map((task) => buildTaskView(task, receiptsById.get(task.receipt_id) ?? null, matchesByHandleNorm)),
  };
}

export async function getEbayDeletionManualReviewTaskDetail(
  taskId: string,
  deps: ReviewServiceDependencies = {},
): Promise<EbayDeletionReviewTaskDetailView | null> {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) return null;

  const store = deps.store ?? createDbReviewStore();
  const task = await store.getTask(normalizedTaskId);
  if (!task) return null;

  const receipt = (await store.listReceiptsByIds([task.receipt_id]))[0] ?? null;
  const matches = await store.listAppUserMatches(collectHandleNorms([task]));
  const matchesByHandleNorm = groupMatchesByHandleNorm(matches);
  const auditEvents = await store.listAuditEvents(task.id);

  return buildDetailView(task, receipt, matchesByHandleNorm, auditEvents);
}

export async function updateEbayDeletionManualReviewTask(
  input: {
    taskId: string;
    reviewState?: EbayDeletionManualReviewState;
    reviewNotes?: string | null;
    setReviewNotes: boolean;
    candidateMatch?: RequestedCandidateMatch | null;
    reviewer: string;
  },
  deps: ReviewServiceDependencies = {},
): Promise<EbayDeletionReviewTaskDetailView | null> {
  const store = deps.store ?? createDbReviewStore();
  const normalizedTaskId = normalizeText(input.taskId);
  if (!normalizedTaskId) return null;

  const currentTask = await store.getTask(normalizedTaskId);
  if (!currentTask) return null;

  const matches = await store.listAppUserMatches(collectHandleNorms([currentTask]));
  const matchesByHandleNorm = groupMatchesByHandleNorm(matches);

  const selectedCandidate =
    input.candidateMatch && input.candidateMatch !== null
      ? resolveRequestedCandidateMatch(currentTask, matchesByHandleNorm, input.candidateMatch)
      : undefined;

  const updated = await store.applyTaskUpdate({
    taskId: normalizedTaskId,
    reviewState: input.reviewState,
    setReviewNotes: input.setReviewNotes,
    reviewNotes: input.reviewNotes,
    candidateMatch:
      input.candidateMatch === undefined
        ? undefined
        : input.candidateMatch === null
          ? null
          : selectedCandidate,
    clearCandidateMatch: input.candidateMatch === null,
    reviewer: normalizeText(input.reviewer) || "admin",
  });

  if (!updated) return null;

  const receipt = (await store.listReceiptsByIds([updated.receipt_id]))[0] ?? null;
  const updatedMatches = await store.listAppUserMatches(collectHandleNorms([updated]));
  const updatedMatchesByHandleNorm = groupMatchesByHandleNorm(updatedMatches);
  const auditEvents = await store.listAuditEvents(updated.id);

  return buildDetailView(updated, receipt, updatedMatchesByHandleNorm, auditEvents);
}
