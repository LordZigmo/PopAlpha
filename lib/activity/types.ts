/**
 * Shared activity/social types — consumed by both web UI and iOS (via JSON contract).
 */

// ── Event Types ─────────────────────────────────────────────────────────────

export type ActivityEventType =
  | "collection.card_added"
  | "wishlist.card_added"
  | "social.followed_user"
  | "milestone.set_progress"
  | "milestone.collection_value"
  | "collection.grade_upgraded";

export const ACTIVITY_EVENT_LABELS: Record<ActivityEventType, string> = {
  "collection.card_added": "added to collection",
  "wishlist.card_added": "added to wishlist",
  "social.followed_user": "followed",
  "milestone.set_progress": "reached a set milestone",
  "milestone.collection_value": "hit a collection milestone",
  "collection.grade_upgraded": "upgraded grade on",
};

// ── Feed Item ───────────────────────────────────────────────────────────────

export type ActivityActor = {
  id: string;
  handle: string;
  avatar_initial: string;
};

export type ActivityTargetUser = {
  id: string;
  handle: string;
};

export type ActivityFeedItem = {
  id: number;
  actor: ActivityActor;
  event_type: ActivityEventType;
  canonical_slug: string | null;
  card_name: string | null;
  card_image_url: string | null;
  set_name: string | null;
  target_user: ActivityTargetUser | null;
  metadata: Record<string, unknown>;
  created_at: string;
  like_count: number;
  comment_count: number;
  liked_by_me: boolean;
};

export type ActivityFeedResponse = {
  ok: true;
  items: ActivityFeedItem[];
  next_cursor: number | null;
};

// ── Comments ────────────────────────────────────────────────────────────────

export type ActivityComment = {
  id: number;
  author: { id: string; handle: string };
  body: string;
  created_at: string;
};

export type ActivityCommentsResponse = {
  ok: true;
  comments: ActivityComment[];
};

// ── Notifications ───────────────────────────────────────────────────────────

export type NotificationType = "like" | "comment" | "follow";

export type NotificationItem = {
  id: number;
  type: NotificationType;
  actor: { id: string; handle: string };
  event_id: number | null;
  event_type: ActivityEventType | null;
  read: boolean;
  created_at: string;
};

export type NotificationsResponse = {
  ok: true;
  notifications: NotificationItem[];
  unread_count: number;
  next_cursor: number | null;
};

// ── Card page friend activity ───────────────────────────────────────────────

export type CardFriendActivity = {
  ok: true;
  owner_count: number;
  recent: ActivityFeedItem[];
};
