import { NextResponse } from "next/server.js";
import {
  EBAY_DELETION_MANUAL_REVIEW_STATES,
  EbayDeletionReviewUpdateError,
  getEbayDeletionManualReviewTaskDetail,
  isEbayDeletionManualReviewState,
  listEbayDeletionManualReviewTasks,
  updateEbayDeletionManualReviewTask,
  type EbayDeletionManualReviewState,
} from "@/lib/ebay/deletion-review";

type RequireInternalAdminResult =
  | {
      ok: true;
      session: {
        actorIdentifier: string;
      };
    }
  | {
      ok: false;
      response: Response;
    };

type RequireInternalAdminFn = (req: Request) => Promise<RequireInternalAdminResult>;

type CandidateMatchBody = {
  clerkUserId?: unknown;
  handleNorm?: unknown;
};

type UpdateReviewRequestBody = {
  reviewState?: unknown;
  reviewNotes?: unknown;
  candidateMatch?: unknown;
};

type RouteDependencies = {
  requireInternalAdminFn?: RequireInternalAdminFn;
  listTasks?: typeof listEbayDeletionManualReviewTasks;
  getTaskDetail?: typeof getEbayDeletionManualReviewTaskDetail;
  updateTask?: typeof updateEbayDeletionManualReviewTask;
};

const MAX_REVIEW_NOTES_LENGTH = 4000;
const ALLOWED_PATCH_FIELDS = new Set(["reviewState", "reviewNotes", "candidateMatch"]);

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReviewState(value: string | null): EbayDeletionManualReviewState | undefined {
  const normalized = value?.trim() ?? "";
  if (!normalized) return undefined;
  if (!isEbayDeletionManualReviewState(normalized)) {
    throw new Error(`reviewState must be one of: ${EBAY_DELETION_MANUAL_REVIEW_STATES.join(", ")}`);
  }
  return normalized;
}

function operatorLabelForRequest(auth: Extract<RequireInternalAdminResult, { ok: true }>): string {
  return auth.session.actorIdentifier;
}

async function defaultRequireInternalAdmin(req: Request): Promise<RequireInternalAdminResult> {
  const { requireInternalAdminApiAccess } = await import("@/lib/auth/internal-admin-session");
  return requireInternalAdminApiAccess(req) as Promise<RequireInternalAdminResult>;
}

async function resolveTaskId(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  return id?.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCandidateMatch(value: unknown): { clerkUserId: string; handleNorm: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error("candidateMatch must be an object or null.");
  }

  const raw = value as CandidateMatchBody;
  const clerkUserId = typeof raw.clerkUserId === "string" ? raw.clerkUserId.trim() : "";
  const handleNorm = typeof raw.handleNorm === "string" ? raw.handleNorm.trim() : "";
  if (!clerkUserId || !handleNorm) {
    throw new Error("candidateMatch must include non-empty clerkUserId and handleNorm values.");
  }

  return { clerkUserId, handleNorm };
}

export async function handleAdminEbayDeletionTaskList(
  req: Request,
  deps: RouteDependencies = {},
): Promise<Response> {
  const requireInternalAdminFn = deps.requireInternalAdminFn ?? defaultRequireInternalAdmin;
  const listTasks = deps.listTasks ?? listEbayDeletionManualReviewTasks;

  const auth = await requireInternalAdminFn(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  let reviewState: EbayDeletionManualReviewState | undefined;
  try {
    reviewState = normalizeReviewState(url.searchParams.get("reviewState"));
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid reviewState." },
      { status: 400 },
    );
  }

  const result = await listTasks({
    limit: parseLimit(url.searchParams.get("limit")),
    reviewState,
    notificationId: url.searchParams.get("notificationId")?.trim() ?? undefined,
  });

  return NextResponse.json({
    ok: true,
    mode: "manual_review_only",
    allowedReviewStates: EBAY_DELETION_MANUAL_REVIEW_STATES,
    filters: {
      reviewState: reviewState ?? null,
      notificationId: url.searchParams.get("notificationId")?.trim() || null,
      limit: parseLimit(url.searchParams.get("limit")) ?? null,
    },
    ...result,
  });
}

export async function handleAdminEbayDeletionTaskDetail(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: RouteDependencies = {},
): Promise<Response> {
  const requireInternalAdminFn = deps.requireInternalAdminFn ?? defaultRequireInternalAdmin;
  const getTaskDetail = deps.getTaskDetail ?? getEbayDeletionManualReviewTaskDetail;

  const auth = await requireInternalAdminFn(req);
  if (!auth.ok) return auth.response;

  const id = await resolveTaskId(params);
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing task id." }, { status: 400 });
  }

  const detail = await getTaskDetail(id);
  if (!detail) {
    return NextResponse.json({ ok: false, error: "Task not found." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    mode: "manual_review_only",
    allowedReviewStates: EBAY_DELETION_MANUAL_REVIEW_STATES,
    ...detail,
  });
}

export async function handleAdminEbayDeletionTaskPatch(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: RouteDependencies = {},
): Promise<Response> {
  const requireInternalAdminFn = deps.requireInternalAdminFn ?? defaultRequireInternalAdmin;
  const updateTask = deps.updateTask ?? updateEbayDeletionManualReviewTask;

  const auth = await requireInternalAdminFn(req);
  if (!auth.ok) return auth.response;

  const id = await resolveTaskId(params);
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing task id." }, { status: 400 });
  }

  let body: UpdateReviewRequestBody;
  try {
    body = (await req.json()) as UpdateReviewRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isRecord(body)) {
    return NextResponse.json({ ok: false, error: "Request body must be a JSON object." }, { status: 400 });
  }

  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_PATCH_FIELDS.has(key));
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unsupported fields: ${unknownKeys.join(", ")}.`,
        allowedFields: [...ALLOWED_PATCH_FIELDS],
      },
      { status: 400 },
    );
  }

  let reviewState: EbayDeletionManualReviewState | undefined;
  let candidateMatch: { clerkUserId: string; handleNorm: string } | null | undefined;
  try {
    reviewState = typeof body.reviewState === "string" ? normalizeReviewState(body.reviewState) : undefined;
    candidateMatch = normalizeCandidateMatch(body.candidateMatch);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid review update." },
      { status: 400 },
    );
  }

  let reviewNotes: string | null | undefined;
  if ("reviewNotes" in body) {
    if (body.reviewNotes === null) {
      reviewNotes = null;
    } else if (typeof body.reviewNotes === "string") {
      const normalized = body.reviewNotes.trim();
      if (normalized.length > MAX_REVIEW_NOTES_LENGTH) {
        return NextResponse.json(
          { ok: false, error: `reviewNotes must be ${MAX_REVIEW_NOTES_LENGTH} characters or fewer.` },
          { status: 400 },
        );
      }
      reviewNotes = normalized || null;
    } else {
      return NextResponse.json(
        { ok: false, error: "reviewNotes must be a string or null." },
        { status: 400 },
      );
    }
  }

  if (reviewState === undefined && reviewNotes === undefined && candidateMatch === undefined) {
    return NextResponse.json(
      { ok: false, error: "Provide reviewState, reviewNotes, and/or candidateMatch." },
      { status: 400 },
    );
  }

  try {
    const detail = await updateTask({
      taskId: id,
      reviewState,
      reviewNotes,
      setReviewNotes: "reviewNotes" in body,
      candidateMatch,
      reviewer: operatorLabelForRequest(auth),
    });

    if (!detail) {
      return NextResponse.json({ ok: false, error: "Task not found." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      mode: "manual_review_only",
      allowedReviewStates: EBAY_DELETION_MANUAL_REVIEW_STATES,
      ...detail,
    });
  } catch (error) {
    if (error instanceof EbayDeletionReviewUpdateError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
