import Foundation

// MARK: - Activity Service — Fetches social feed data from PopAlpha API

actor ActivityService {
    static let shared = ActivityService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: - Models (matches web API JSON contract)

    struct ActivityActor: Decodable, Hashable {
        let id: String
        let handle: String
        let avatarInitial: String
    }

    struct ActivityTargetUser: Decodable, Hashable {
        let id: String
        let handle: String
    }

    struct ActivityFeedItem: Decodable, Identifiable, Hashable {
        let id: Int
        let actor: ActivityActor
        let eventType: String
        let canonicalSlug: String?
        let cardName: String?
        let cardImageUrl: String?
        let setName: String?
        let targetUser: ActivityTargetUser?
        let metadata: [String: AnyCodable]?
        let createdAt: String
        let likeCount: Int
        let commentCount: Int
        let likedByMe: Bool

        var actionText: String {
            switch eventType {
            case "collection.card_added":
                return "added \(cardName ?? "a card") to their collection"
            case "wishlist.card_added":
                return "added \(cardName ?? "a card") to their wishlist"
            case "social.followed_user":
                return "followed @\(targetUser?.handle ?? "a collector")"
            case "milestone.set_progress":
                let pct = metadata?["percent"]?.value ?? "?"
                return "reached \(pct)% completion on \(setName ?? metadata?["set_name"]?.value ?? "a set")"
            case "milestone.collection_value":
                if let val = metadata?["value"]?.value, let num = Double(val) {
                    return "hit $\(Int(num).formatted()) collection value"
                }
                return "hit a collection milestone"
            case "collection.grade_upgraded":
                let newGrade = metadata?["new_grade"]?.value ?? "graded"
                return "upgraded \(cardName ?? "a card") to \(newGrade)"
            default:
                return "did something"
            }
        }

        var timeAgo: String {
            let formatter = ISO8601DateFormatter()
            guard let date = formatter.date(from: createdAt) else { return "" }
            let seconds = Int(Date().timeIntervalSince(date))
            if seconds < 60 { return "now" }
            let minutes = seconds / 60
            if minutes < 60 { return "\(minutes)m" }
            let hours = minutes / 60
            if hours < 24 { return "\(hours)h" }
            let days = hours / 24
            return "\(days)d"
        }

        var cardImageURL: URL? {
            cardImageUrl.flatMap(URL.init(string:))
        }

        var hasCardImage: Bool {
            cardImageUrl != nil && (
                eventType == "collection.card_added" ||
                eventType == "wishlist.card_added" ||
                eventType == "collection.grade_upgraded"
            )
        }
    }

    struct ActivityComment: Decodable, Identifiable {
        let id: Int
        let author: ActivityActor
        let body: String
        let createdAt: String
    }

    struct NotificationItem: Decodable, Identifiable {
        let id: Int
        let type: String
        let actor: ActivityActor
        let eventId: Int?
        let eventType: String?
        let read: Bool
        let createdAt: String

        var text: String {
            switch type {
            case "like": return "@\(actor.handle) liked your activity"
            case "comment": return "@\(actor.handle) commented on your activity"
            case "follow": return "@\(actor.handle) started following you"
            default: return "@\(actor.handle) interacted with you"
            }
        }
    }

    // MARK: - AnyCodable helper for metadata

    struct AnyCodable: Decodable, Hashable {
        let value: String

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let str = try? container.decode(String.self) {
                value = str
            } else if let num = try? container.decode(Double.self) {
                value = String(num)
            } else if let bool = try? container.decode(Bool.self) {
                value = String(bool)
            } else {
                value = ""
            }
        }
    }

    // MARK: - API Response Wrappers

    private struct FeedResponse: Decodable {
        let ok: Bool
        let items: [ActivityFeedItem]
        let nextCursor: Int?
    }

    private struct CommentsResponse: Decodable {
        let ok: Bool
        let comments: [ActivityComment]
    }

    private struct NotificationsResponse: Decodable {
        let ok: Bool
        let notifications: [NotificationItem]
        let unreadCount: Int
        let nextCursor: Int?
    }

    // MARK: - Card Activity Response

    struct CardActivityResponse: Decodable {
        let ok: Bool
        let ownerCount: Int
        let recent: [ActivityFeedItem]
    }

    private struct LikeResponse: Decodable {
        let ok: Bool
        let liked: Bool
        let likeCount: Int
    }

    private struct CommentPostResponse: Decodable {
        let ok: Bool
        let id: Int?
        let createdAt: String?
    }

    private struct SimpleOkResponse: Decodable {
        let ok: Bool
    }

    // MARK: - Feed

    /// Fetch following feed with cursor-based pagination
    func fetchFeed(cursor: Int? = nil, limit: Int = 20) async throws -> (items: [ActivityFeedItem], nextCursor: Int?) {
        try AuthService.shared.requireAuth()

        var query: [(String, String)] = [("limit", String(limit))]
        if let cursor { query.append(("cursor", String(cursor))) }

        let response: FeedResponse = try await APIClient.get(
            path: "/api/activity/feed",
            query: query,
            decoder: decoder
        )
        return (response.items, response.nextCursor)
    }

    /// Fetch a specific user's activity by handle
    func fetchProfileActivity(handle: String, cursor: Int? = nil, limit: Int = 20) async throws -> (items: [ActivityFeedItem], nextCursor: Int?) {
        try AuthService.shared.requireAuth()

        var query: [(String, String)] = [("handle", handle), ("limit", String(limit))]
        if let cursor { query.append(("cursor", String(cursor))) }

        let response: FeedResponse = try await APIClient.get(
            path: "/api/activity/profile",
            query: query,
            decoder: decoder
        )
        return (response.items, response.nextCursor)
    }

    // MARK: - Comments

    /// Fetch comments for an activity event
    func fetchComments(eventId: Int, limit: Int = 50) async throws -> [ActivityComment] {
        try AuthService.shared.requireAuth()

        let response: CommentsResponse = try await APIClient.get(
            path: "/api/activity/comments",
            query: [("event_id", String(eventId)), ("limit", String(limit))],
            decoder: decoder
        )
        return response.comments
    }

    /// Post a comment on an activity event (1-500 chars)
    func postComment(eventId: Int, body: String) async throws -> ActivityComment? {
        try AuthService.shared.requireAuth()

        let response: CommentPostResponse = try await APIClient.post(
            path: "/api/activity/comments",
            body: ["event_id": eventId, "body": body],
            decoder: decoder
        )

        guard response.ok, let id = response.id, let createdAt = response.createdAt else {
            return nil
        }

        // Build a local comment from the response
        let handle = AuthService.shared.currentHandle ?? "you"
        let userId = AuthService.shared.currentUserId ?? ""
        return ActivityComment(
            id: id,
            author: ActivityActor(id: userId, handle: handle, avatarInitial: String(handle.prefix(1)).uppercased()),
            body: body,
            createdAt: createdAt
        )
    }

    // MARK: - Likes

    /// Toggle like on an activity event (returns new state)
    func toggleLike(eventId: Int) async throws -> (liked: Bool, likeCount: Int) {
        try AuthService.shared.requireAuth()

        let response: LikeResponse = try await APIClient.post(
            path: "/api/activity/like",
            body: ["event_id": eventId],
            decoder: decoder
        )
        return (response.liked, response.likeCount)
    }

    // MARK: - Notifications

    /// Fetch notifications with unread count
    func fetchNotifications(cursor: Int? = nil, limit: Int = 20) async throws -> (items: [NotificationItem], unreadCount: Int) {
        try AuthService.shared.requireAuth()

        var query: [(String, String)] = [("limit", String(limit))]
        if let cursor { query.append(("cursor", String(cursor))) }

        let response: NotificationsResponse = try await APIClient.get(
            path: "/api/activity/notifications",
            query: query,
            decoder: decoder
        )
        return (response.notifications, response.unreadCount)
    }

    /// Mark notifications as read (nil = mark all)
    func markNotificationsRead(ids: [Int]? = nil) async throws {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = [:]
        if let ids { body["ids"] = ids }

        let _: SimpleOkResponse = try await APIClient.post(
            path: "/api/activity/notifications/read",
            body: body,
            decoder: decoder
        )
    }

    // MARK: - Card Activity

    /// Fetch friend activity for a specific card
    func fetchCardActivity(slug: String) async throws -> CardActivityResponse {
        try AuthService.shared.requireAuth()

        return try await APIClient.get(
            path: "/api/activity/card",
            query: [("slug", slug)],
            decoder: decoder
        )
    }
}
