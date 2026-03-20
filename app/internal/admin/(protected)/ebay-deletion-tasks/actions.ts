"use server";

import { redirect } from "next/navigation.js";
import { requireInternalAdminSession } from "@/lib/auth/internal-admin-session";
import {
  getInternalAdminEbayDeletionTaskDetail,
  InternalAdminReviewApiError,
  patchInternalAdminEbayDeletionTask,
} from "@/lib/ebay/deletion-review-admin-api";
import { isEbayDeletionManualReviewState } from "@/lib/ebay/deletion-review";

type TaskPageState = {
  reviewState?: string | null;
  notificationId?: string | null;
  task?: string | null;
  notice?: string | null;
  error?: string | null;
};

const CLEAR_CANDIDATE_VALUE = "__NONE__";

function normalizeTaskPageState(input: TaskPageState): TaskPageState {
  return {
    reviewState: input.reviewState?.trim() || null,
    notificationId: input.notificationId?.trim() || null,
    task: input.task?.trim() || null,
    notice: input.notice?.trim() || null,
    error: input.error?.trim() || null,
  };
}

function buildTaskPageHref(input: TaskPageState): string {
  const normalized = normalizeTaskPageState(input);
  const search = new URLSearchParams();
  if (normalized.reviewState) search.set("reviewState", normalized.reviewState);
  if (normalized.notificationId) search.set("notificationId", normalized.notificationId);
  if (normalized.task) search.set("task", normalized.task);
  if (normalized.notice) search.set("notice", normalized.notice);
  if (normalized.error) search.set("error", normalized.error);
  const query = search.toString();
  return query
    ? `/internal/admin/ebay-deletion-tasks?${query}`
    : "/internal/admin/ebay-deletion-tasks";
}

function redirectWithState(
  state: TaskPageState,
  next: { notice?: string | null; error?: string | null } = {},
): never {
  redirect(
    buildTaskPageHref({
      ...state,
      notice: next.notice ?? null,
      error: next.error ?? null,
    }),
  );
}

function parseTaskPageStateFromForm(formData: FormData): TaskPageState {
  return {
    reviewState: typeof formData.get("returnReviewState") === "string"
      ? String(formData.get("returnReviewState"))
      : null,
    notificationId: typeof formData.get("returnNotificationId") === "string"
      ? String(formData.get("returnNotificationId"))
      : null,
    task: typeof formData.get("taskId") === "string"
      ? String(formData.get("taskId"))
      : null,
  };
}

function normalizeOptionalNotes(value: FormDataEntryValue | null): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function parseCandidateSelection(value: FormDataEntryValue | null): { clerkUserId: string; handleNorm: string } | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw === CLEAR_CANDIDATE_VALUE) {
    return null;
  }

  const [clerkUserId, handleNorm] = raw.split("::");
  if (!clerkUserId || !handleNorm) {
    throw new Error("candidate selection is malformed");
  }

  return { clerkUserId, handleNorm };
}

export async function updateEbayDeletionReviewFieldsAction(formData: FormData): Promise<never> {
  const taskState = parseTaskPageStateFromForm(formData);
  const taskId = taskState.task?.trim() ?? "";
  await requireInternalAdminSession(buildTaskPageHref(taskState));

  if (!taskId) {
    redirectWithState(taskState, { error: "missing_task" });
  }

  const reviewStateRaw = typeof formData.get("reviewState") === "string"
    ? String(formData.get("reviewState")).trim()
    : "";
  if (!isEbayDeletionManualReviewState(reviewStateRaw)) {
    redirectWithState(taskState, { error: "invalid_review_state" });
  }

  const reviewNotes = normalizeOptionalNotes(formData.get("reviewNotes"));
  let detail;
  try {
    detail = await getInternalAdminEbayDeletionTaskDetail(taskId);
  } catch (error) {
    if (error instanceof InternalAdminReviewApiError) {
      if (error.status === 404) {
        redirectWithState(taskState, { error: "task_not_found" });
      }
      redirectWithState(taskState, { error: "review_update_failed" });
    }
    throw error;
  }

  const payload: {
    reviewState?: typeof detail.task.reviewState;
    reviewNotes?: string | null;
  } = {};

  if (detail.task.reviewState !== reviewStateRaw) {
    payload.reviewState = reviewStateRaw;
  }
  if ((detail.task.reviewNotes ?? null) !== reviewNotes) {
    payload.reviewNotes = reviewNotes;
  }

  if (Object.keys(payload).length === 0) {
    redirectWithState(taskState, { notice: "no_changes" });
  }

  try {
    await patchInternalAdminEbayDeletionTask(taskId, payload);
  } catch (error) {
    if (error instanceof InternalAdminReviewApiError) {
      redirectWithState(taskState, { error: "review_update_failed" });
    }
    throw error;
  }
  redirectWithState(taskState, { notice: "review_saved" });
}

export async function updateEbayDeletionCandidateMatchAction(formData: FormData): Promise<never> {
  const taskState = parseTaskPageStateFromForm(formData);
  const taskId = taskState.task?.trim() ?? "";
  await requireInternalAdminSession(buildTaskPageHref(taskState));

  if (!taskId) {
    redirectWithState(taskState, { error: "missing_task" });
  }

  let candidateMatch: { clerkUserId: string; handleNorm: string } | null;
  try {
    candidateMatch = parseCandidateSelection(formData.get("candidateMatch"));
  } catch {
    redirectWithState(taskState, { error: "invalid_candidate" });
  }

  let detail;
  try {
    detail = await getInternalAdminEbayDeletionTaskDetail(taskId);
  } catch (error) {
    if (error instanceof InternalAdminReviewApiError) {
      if (error.status === 404) {
        redirectWithState(taskState, { error: "task_not_found" });
      }
      redirectWithState(taskState, { error: "candidate_update_failed" });
    }
    throw error;
  }
  const current = detail.task.selectedCandidateMatch;
  const unchanged = (!candidateMatch && !current)
    || (
      candidateMatch
      && current
      && candidateMatch.clerkUserId === current.clerkUserId
      && candidateMatch.handleNorm === current.handleNorm
    );

  if (unchanged) {
    redirectWithState(taskState, { notice: "no_changes" });
  }

  try {
    await patchInternalAdminEbayDeletionTask(taskId, { candidateMatch });
  } catch (error) {
    if (error instanceof InternalAdminReviewApiError) {
      redirectWithState(taskState, { error: "candidate_update_failed" });
    }
    throw error;
  }
  redirectWithState(taskState, {
    notice: candidateMatch ? "candidate_saved" : "candidate_cleared",
  });
}
