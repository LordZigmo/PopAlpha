/**
 * Moderation types — shared between web routes and the iOS JSON contract.
 */

export type ReportTargetKind = "comment" | "event" | "profile" | "profile_post";

export type ReportReason =
  | "spam"
  | "harassment"
  | "hate"
  | "sexual"
  | "violence"
  | "other";

export const REPORT_REASONS: ReportReason[] = [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "other",
];

export type BlockSummary = {
  blocked_id: string;
  blocked_handle: string | null;
  created_at: string;
};

export type BlocksListResponse = {
  ok: true;
  blocks: BlockSummary[];
};

export type ReportSubmitResponse = {
  ok: true;
  id: number;
};
