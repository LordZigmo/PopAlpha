import Link from "next/link";
import { requireInternalAdminSession } from "@/lib/auth/internal-admin-session";
import {
  EBAY_DELETION_MANUAL_REVIEW_STATES,
  type EbayDeletionReviewAuditEventView,
  type EbayDeletionReviewTaskDetailView,
  type EbayDeletionReviewTaskView,
} from "@/lib/ebay/deletion-review";
import {
  getInternalAdminEbayDeletionTaskDetail,
  InternalAdminReviewApiError,
  listInternalAdminEbayDeletionTasks,
} from "@/lib/ebay/deletion-review-admin-api";
import {
  updateEbayDeletionCandidateMatchAction,
  updateEbayDeletionReviewFieldsAction,
} from "@/app/internal/admin/(protected)/ebay-deletion-tasks/actions";

export const dynamic = "force-dynamic";

type RawSearchParams = {
  reviewState?: string;
  notificationId?: string;
  task?: string;
  notice?: string;
  error?: string;
};

type SearchParams = {
  reviewState?: EbayDeletionReviewTaskView["reviewState"];
  notificationId?: string;
  task?: string;
  notice?: string;
  error?: string;
};

type CandidateOption = {
  value: string;
  label: string;
  help: string;
  selected: boolean;
};

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function isReviewState(value: string): value is EbayDeletionReviewTaskView["reviewState"] {
  return (EBAY_DELETION_MANUAL_REVIEW_STATES as readonly string[]).includes(value);
}

function parseSearchParams(value: RawSearchParams): SearchParams {
  const reviewState = value.reviewState?.trim() ?? "";
  const notificationId = value.notificationId?.trim() ?? "";
  const task = value.task?.trim() ?? "";
  const notice = value.notice?.trim() ?? "";
  const error = value.error?.trim() ?? "";

  return {
    reviewState: isReviewState(reviewState) ? reviewState : undefined,
    notificationId: notificationId || undefined,
    task: task || undefined,
    notice: notice || undefined,
    error: error || undefined,
  };
}

function buildPageHref(input: SearchParams): string {
  const search = new URLSearchParams();
  if (input.reviewState) search.set("reviewState", input.reviewState);
  if (input.notificationId) search.set("notificationId", input.notificationId);
  if (input.task) search.set("task", input.task);
  const query = search.toString();
  return query ? `/internal/admin/ebay-deletion-tasks?${query}` : "/internal/admin/ebay-deletion-tasks";
}

function reviewStateTone(reviewState: EbayDeletionReviewTaskView["reviewState"]): string {
  switch (reviewState) {
    case "matched_candidate":
      return "border-[#21492A] bg-[#122117] text-[#CBF7D4]";
    case "no_match_found":
      return "border-[#4A3720] bg-[#21170E] text-[#FFD7A6]";
    case "escalated":
      return "border-[#4A2121] bg-[#241111] text-[#FFD0D0]";
    case "needs_more_context":
      return "border-[#243A4E] bg-[#0F1C26] text-[#CCE8FF]";
    default:
      return "border-[#2B2B2B] bg-[#171717] text-[#E7E7E7]";
  }
}

function noticeMessage(code: string | undefined): { tone: string; message: string } | null {
  switch (code) {
    case "review_saved":
      return { tone: "border-[#204A2F] bg-[#112316] text-[#C8F8D1]", message: "Review state and notes saved." };
    case "candidate_saved":
      return { tone: "border-[#204A2F] bg-[#112316] text-[#C8F8D1]", message: "Advisory candidate selection saved." };
    case "candidate_cleared":
      return { tone: "border-[#4A3720] bg-[#21170E] text-[#FFE0B6]", message: "Advisory candidate selection cleared." };
    case "no_changes":
      return { tone: "border-[#2B2B2B] bg-[#171717] text-[#E7E7E7]", message: "No review changes were submitted." };
    default:
      return null;
  }
}

function errorMessage(code: string | undefined): { tone: string; message: string } | null {
  switch (code) {
    case "missing_task":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "Select a task before submitting a review update." };
    case "invalid_review_state":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "Review state value was not recognized." };
    case "invalid_candidate":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "Candidate selection was malformed." };
    case "task_not_found":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "That task no longer exists in the current manual-review queue." };
    case "review_update_failed":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "Review state update did not complete. Reload the task detail and try again." };
    case "candidate_update_failed":
      return { tone: "border-[#4A2121] bg-[#241111] text-[#FFD0D0]", message: "Candidate selection update did not complete. Reload the task detail and try again." };
    default:
      return null;
  }
}

function buildCandidateOptions(detail: EbayDeletionReviewTaskDetailView): CandidateOption[] {
  const current = detail.task.selectedCandidateMatch;
  const exactMatches = detail.task.advisoryMatches.exactAppUserMatches;
  const options: CandidateOption[] = [];
  const seen = new Set<string>();

  if (current) {
    const key = `${current.clerkUserId}::${current.handleNorm}`;
    seen.add(key);
    options.push({
      value: key,
      label: `${current.handle} (${current.clerkUserId})`,
      help: current.matchReason === "exact_handle_candidate"
        ? "Currently selected advisory exact-handle candidate."
        : `Currently selected advisory candidate (${current.matchReason}).`,
      selected: true,
    });
  }

  for (const match of exactMatches) {
    const key = `${match.clerkUserId}::${match.handleNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      value: key,
      label: `${match.handle} (${match.clerkUserId})`,
      help: `Advisory exact-handle candidate • profile ${match.profileVisibility.toLowerCase()} • created ${formatWhen(match.createdAt)}`,
      selected: false,
    });
  }

  options.push({
    value: "__NONE__",
    label: "No advisory candidate selected",
    help: "Clears the saved advisory candidate. This does not dismiss the task or affect any user data.",
    selected: current === null,
  });

  return options;
}

function renderReceiptSummary(detail: EbayDeletionReviewTaskDetailView["task"]) {
  const receipt = detail.receipt;
  if (!receipt) {
    return <p className="mt-3 text-[13px] text-[#9A9A9A]">Receipt metadata unavailable.</p>;
  }

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-[1.25rem] border border-[#202020] bg-black/40 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Verification</p>
        <p className="mt-2 text-[13px] text-white">Kid {receipt.signature.kid}</p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">
          {receipt.signature.algorithm} / {receipt.signature.digest}
        </p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">Key digest {receipt.signature.verificationKeyDigest}</p>
      </div>
      <div className="rounded-[1.25rem] border border-[#202020] bg-black/40 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Receipt Processing</p>
        <p className="mt-2 text-[13px] text-white">{receipt.processingStatus}</p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">{receipt.processingOutcome ?? "No processing outcome recorded"}</p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">Attempts {receipt.attemptCount}</p>
      </div>
      <div className="rounded-[1.25rem] border border-[#202020] bg-black/40 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Verified Payload</p>
        <p className="mt-2 text-[13px] text-white">Schema {receipt.verifiedPayload.schemaVersion}</p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">
          EIAS token {receipt.verifiedPayload.hasEiasToken === null ? "unknown" : receipt.verifiedPayload.hasEiasToken ? "present" : "absent"}
        </p>
        <p className="mt-1 text-[12px] text-[#9C9C9C]">SHA-256 {receipt.verifiedPayload.payloadSha256Prefix}…</p>
      </div>
    </div>
  );
}

function renderAuditEvent(event: EbayDeletionReviewAuditEventView) {
  return (
    <li key={event.id} className="rounded-[1.25rem] border border-[#202020] bg-black/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-white">{event.eventType}</p>
        <p className="text-[11px] uppercase tracking-[0.14em] text-[#7E7E7E]">{formatWhen(event.createdAt)}</p>
      </div>
      <p className="mt-2 text-[12px] text-[#A5A5A5]">Actor {event.actorIdentifier}</p>
      {(event.priorReviewState || event.newReviewState) ? (
        <p className="mt-2 text-[12px] text-[#D5D5D5]">
          {event.priorReviewState ?? "none"} → {event.newReviewState ?? "none"}
        </p>
      ) : null}
      {event.notePayload ? (
        <p className="mt-2 whitespace-pre-wrap rounded-xl border border-[#242424] bg-[#111111] px-3 py-2 text-[12px] leading-6 text-[#DBDBDB]">
          {event.notePayload}
        </p>
      ) : null}
      {event.candidateMatch ? (
        <p className="mt-2 text-[12px] text-[#D5D5D5]">
          Candidate {event.candidateMatch.handle ?? "unknown"} ({event.candidateMatch.clerkUserId ?? "unknown"}) • {event.candidateMatch.reason ?? "advisory"}
        </p>
      ) : null}
    </li>
  );
}

export default async function InternalAdminEbayDeletionTasksPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireInternalAdminSession("/internal/admin/ebay-deletion-tasks");
  const params = parseSearchParams(await searchParams);
  const list = await listInternalAdminEbayDeletionTasks({
    reviewState: params.reviewState ?? null,
    notificationId: params.notificationId ?? null,
    limit: 50,
  });

  const selectedTaskId = params.task ?? list.tasks[0]?.id ?? null;
  let detail: EbayDeletionReviewTaskDetailView | null = null;
  if (selectedTaskId) {
    try {
      detail = await getInternalAdminEbayDeletionTaskDetail(selectedTaskId);
    } catch (error) {
      if (!(error instanceof InternalAdminReviewApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  const notice = noticeMessage(params.notice);
  const error = errorMessage(params.error ?? ((selectedTaskId && !detail && params.task) ? "task_not_found" : undefined));
  const pageHrefBase = buildPageHref({
    reviewState: params.reviewState,
    notificationId: params.notificationId,
    task: selectedTaskId ?? undefined,
  });
  const candidateOptions = detail ? buildCandidateOptions(detail) : [];

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.45fr]">
      <section className="rounded-[1.75rem] border border-[#1E1E1E] bg-[#0F0F0F] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6E6E6E]">Review Queue</p>
            <p className="mt-2 text-[14px] leading-6 text-[#A2A2A2]">
              Filter verified tasks, then inspect the selected manual-review record on the right.
            </p>
          </div>
          <div className="rounded-2xl border border-[#1E1E1E] bg-black/40 px-4 py-3 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#737373]">Tasks</p>
            <p className="mt-1 text-[20px] font-semibold text-white">{list.summary.total}</p>
          </div>
        </div>

        <form method="GET" className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Review State</span>
            <select
              name="reviewState"
              defaultValue={params.reviewState ?? ""}
              className="mt-2 w-full rounded-2xl border border-[#262626] bg-black px-4 py-3 text-[14px] text-white"
            >
              <option value="">All states</option>
              {EBAY_DELETION_MANUAL_REVIEW_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Notification ID</span>
            <input
              name="notificationId"
              type="text"
              defaultValue={params.notificationId ?? ""}
              placeholder="notif-123"
              className="mt-2 w-full rounded-2xl border border-[#262626] bg-black px-4 py-3 text-[14px] text-white"
            />
          </label>
          <button
            type="submit"
            className="mt-[1.65rem] inline-flex items-center justify-center rounded-2xl border border-[#2A2A2A] bg-white/[0.05] px-4 py-3 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
          >
            Apply
          </button>
        </form>

        <div className="mt-5 flex flex-wrap gap-2">
          {EBAY_DELETION_MANUAL_REVIEW_STATES.map((state) => (
            <span
              key={state}
              className="rounded-full border border-[#242424] bg-black/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#CFCFCF]"
            >
              {state}: {list.summary.byReviewState[state]}
            </span>
          ))}
        </div>

        <ul className="mt-5 space-y-3">
          {list.tasks.length === 0 ? (
            <li className="rounded-[1.5rem] border border-dashed border-[#2A2A2A] bg-black/30 px-4 py-5 text-[14px] text-[#A0A0A0]">
              No verified manual-review tasks matched the current filters.
            </li>
          ) : (
            list.tasks.map((task) => {
              const href = buildPageHref({
                reviewState: params.reviewState,
                notificationId: params.notificationId,
                task: task.id,
              });
              const selected = selectedTaskId === task.id;

              return (
                <li key={task.id}>
                  <Link
                    href={href}
                    className={[
                      "block rounded-[1.5rem] border px-4 py-4 transition",
                      selected
                        ? "border-[#5A5A5A] bg-white/[0.06]"
                        : "border-[#202020] bg-black/35 hover:border-[#333333] hover:bg-black/45",
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-[14px] font-semibold text-white">{task.notificationId}</p>
                        <p className="mt-1 text-[12px] text-[#A1A1A1]">
                          {task.ebayUsername ?? "No username"} • eBay user {task.ebayUserId}
                        </p>
                      </div>
                      <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${reviewStateTone(task.reviewState)}`}>
                        {task.reviewState}
                      </span>
                    </div>
                    <p className="mt-3 text-[12px] text-[#8E8E8E]">
                      Created {formatWhen(task.createdAt)} • Receipt {task.receipt?.processingStatus ?? "unknown"}
                    </p>
                    {task.selectedCandidateMatch ? (
                      <p className="mt-2 text-[12px] text-[#D0D0D0]">
                        Advisory candidate: {task.selectedCandidateMatch.handle} ({task.selectedCandidateMatch.clerkUserId})
                      </p>
                    ) : null}
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section className="rounded-[1.75rem] border border-[#1E1E1E] bg-[#0F0F0F] p-5">
        {notice ? (
          <div className={`mb-4 rounded-2xl border px-4 py-3 text-[13px] ${notice.tone}`}>{notice.message}</div>
        ) : null}
        {error ? (
          <div className={`mb-4 rounded-2xl border px-4 py-3 text-[13px] ${error.tone}`}>{error.message}</div>
        ) : null}

        {!detail ? (
          <div className="rounded-[1.5rem] border border-dashed border-[#2A2A2A] bg-black/30 px-5 py-8">
            <p className="text-[16px] font-semibold text-white">No task selected</p>
            <p className="mt-2 text-[14px] leading-6 text-[#A1A1A1]">
              Choose a manual-review task from the queue to inspect verified receipt metadata, advisory matches,
              and append-only audit history.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#707070]">Task Detail</p>
                <h2 className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-white">
                  {detail.task.notificationId}
                </h2>
                <p className="mt-2 text-[14px] leading-6 text-[#A8A8A8]">
                  Verified eBay account deletion notification for user {detail.task.ebayUserId}. This tool is
                  advisory and review-only.
                </p>
              </div>
              <span className={`rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] ${reviewStateTone(detail.task.reviewState)}`}>
                {detail.task.reviewState}
              </span>
            </div>

            {renderReceiptSummary(detail.task)}

            <div className="mt-6 grid gap-6 2xl:grid-cols-[1.05fr_0.95fr]">
              <div className="space-y-6">
                <section className="rounded-[1.5rem] border border-[#202020] bg-black/35 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6F6F6F]">
                        Review Annotation
                      </p>
                      <p className="mt-2 text-[13px] leading-6 text-[#A2A2A2]">
                        Update only the manual review state and notes. Deletion and erasure remain intentionally disabled.
                      </p>
                    </div>
                    <p className="text-[12px] text-[#878787]">
                      Last changed {formatWhen(detail.task.reviewStateUpdatedAt)} by {detail.task.reviewStateUpdatedBy ?? "unknown"}
                    </p>
                  </div>

                  <form action={updateEbayDeletionReviewFieldsAction} className="mt-5 space-y-4">
                    <input type="hidden" name="taskId" value={detail.task.id} />
                    <input type="hidden" name="returnReviewState" value={params.reviewState ?? ""} />
                    <input type="hidden" name="returnNotificationId" value={params.notificationId ?? ""} />

                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Review State</span>
                      <select
                        name="reviewState"
                        defaultValue={detail.task.reviewState}
                        className="mt-2 w-full rounded-2xl border border-[#262626] bg-[#080808] px-4 py-3 text-[14px] text-white"
                      >
                        {EBAY_DELETION_MANUAL_REVIEW_STATES.map((state) => (
                          <option key={state} value={state}>
                            {state}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Review Notes</span>
                      <textarea
                        name="reviewNotes"
                        defaultValue={detail.task.reviewNotes ?? ""}
                        rows={7}
                        className="mt-2 w-full rounded-[1.5rem] border border-[#262626] bg-[#080808] px-4 py-3 text-[14px] leading-6 text-white"
                        placeholder="Summarize the evidence reviewed, what remains advisory, and why the task should stay pending, escalated, or matched."
                      />
                    </label>

                    <button
                      type="submit"
                      className="inline-flex items-center rounded-2xl bg-white px-4 py-3 text-[13px] font-semibold text-black transition hover:bg-[#E7E7E7]"
                    >
                      Save Review State + Notes
                    </button>
                  </form>
                </section>

                <section className="rounded-[1.5rem] border border-[#202020] bg-black/35 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6F6F6F]">
                        Advisory Candidate Match
                      </p>
                      <p className="mt-2 text-[13px] leading-6 text-[#A2A2A2]">
                        Candidate matches are advisory only. They do not resolve identity and they do not authorize deletion work.
                      </p>
                    </div>
                    {detail.task.selectedCandidateMatch ? (
                      <p className="text-[12px] text-[#8B8B8B]">
                        Current selection {detail.task.selectedCandidateMatch.handle} ({detail.task.selectedCandidateMatch.clerkUserId})
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-4 rounded-[1.25rem] border border-[#202020] bg-[#0B0B0B] px-4 py-4">
                    <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#6F6F6F]">Match Context</p>
                    <p className="mt-2 text-[13px] leading-6 text-[#CBCBCB]">{detail.task.advisoryMatches.note}</p>
                    <p className="mt-3 text-[12px] text-[#8D8D8D]">
                      Candidate handle norms: {detail.task.advisoryMatches.candidateHandleNorms.length > 0 ? detail.task.advisoryMatches.candidateHandleNorms.join(", ") : "none"}
                    </p>
                  </div>

                  <form action={updateEbayDeletionCandidateMatchAction} className="mt-5 space-y-3">
                    <input type="hidden" name="taskId" value={detail.task.id} />
                    <input type="hidden" name="returnReviewState" value={params.reviewState ?? ""} />
                    <input type="hidden" name="returnNotificationId" value={params.notificationId ?? ""} />

                    {candidateOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer gap-3 rounded-[1.25rem] border border-[#242424] bg-[#0B0B0B] px-4 py-4"
                      >
                        <input
                          type="radio"
                          name="candidateMatch"
                          value={option.value}
                          defaultChecked={option.selected}
                          className="mt-1 h-4 w-4 accent-white"
                        />
                        <span>
                          <span className="block text-[14px] font-semibold text-white">{option.label}</span>
                          <span className="mt-1 block text-[12px] leading-6 text-[#A8A8A8]">{option.help}</span>
                        </span>
                      </label>
                    ))}

                    <button
                      type="submit"
                      className="inline-flex items-center rounded-2xl border border-[#2A2A2A] bg-white/[0.05] px-4 py-3 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
                    >
                      Save Advisory Candidate
                    </button>
                  </form>
                </section>
              </div>

              <div className="space-y-6">
                <section className="rounded-[1.5rem] border border-[#202020] bg-black/35 p-5">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6F6F6F]">Verified Receipt Metadata</p>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.25rem] border border-[#202020] bg-[#0A0A0A] px-4 py-3">
                      <dt className="text-[11px] uppercase tracking-[0.14em] text-[#6D6D6D]">Topic</dt>
                      <dd className="mt-2 text-[13px] text-white">{detail.task.topic}</dd>
                    </div>
                    <div className="rounded-[1.25rem] border border-[#202020] bg-[#0A0A0A] px-4 py-3">
                      <dt className="text-[11px] uppercase tracking-[0.14em] text-[#6D6D6D]">Publish Date</dt>
                      <dd className="mt-2 text-[13px] text-white">{formatWhen(detail.task.publishDate)}</dd>
                    </div>
                    <div className="rounded-[1.25rem] border border-[#202020] bg-[#0A0A0A] px-4 py-3">
                      <dt className="text-[11px] uppercase tracking-[0.14em] text-[#6D6D6D]">Event Date</dt>
                      <dd className="mt-2 text-[13px] text-white">{formatWhen(detail.task.eventDate)}</dd>
                    </div>
                    <div className="rounded-[1.25rem] border border-[#202020] bg-[#0A0A0A] px-4 py-3">
                      <dt className="text-[11px] uppercase tracking-[0.14em] text-[#6D6D6D]">Receipt ID</dt>
                      <dd className="mt-2 break-all text-[13px] text-white">{detail.task.receiptId}</dd>
                    </div>
                  </dl>
                </section>

                <section className="rounded-[1.5rem] border border-[#202020] bg-black/35 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6F6F6F]">Audit History</p>
                      <p className="mt-2 text-[13px] leading-6 text-[#A2A2A2]">
                        Append-only operator and worker events for this task. No history is rewritten from this tool.
                      </p>
                    </div>
                    <Link
                      href={pageHrefBase}
                      className="inline-flex items-center rounded-2xl border border-[#2A2A2A] bg-white/[0.05] px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-white/[0.08]"
                    >
                      Refresh Detail
                    </Link>
                  </div>

                  <ul className="mt-5 space-y-3">
                    {detail.auditEvents.length === 0 ? (
                      <li className="rounded-[1.25rem] border border-dashed border-[#2A2A2A] bg-[#0A0A0A] px-4 py-4 text-[13px] text-[#A2A2A2]">
                        No audit events recorded yet.
                      </li>
                    ) : (
                      detail.auditEvents.map(renderAuditEvent)
                    )}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
