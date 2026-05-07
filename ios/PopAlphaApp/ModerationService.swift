import Foundation
import OSLog

// MARK: - Moderation API Client + BlockedUsersStore
//
// Backs the App-Store-required UGC moderation surface (Apple Guideline
// 1.2 / 1.4.3): user blocking and content reporting. Blocked users are
// filtered server-side in feed/comments/profile/notifications routes,
// but we also keep a local cache so views can hide content immediately
// after a block without waiting for a refetch.

enum ReportTargetKind: String, Codable, CaseIterable {
    case comment
    case event
    case profile
    case profilePost = "profile_post"
}

/// Identifier used by `.sheet(item:)` to present a ReportSheet for a
/// specific UGC item. Identifiable on (kind, targetId) so re-tapping
/// the same row replaces the sheet rather than queuing it.
struct ReportTargetIdentifier: Identifiable, Equatable {
    let kind: ReportTargetKind
    let targetId: String
    let label: String?

    var id: String { "\(kind.rawValue):\(targetId)" }
}

/// Identifier used by `.alert(isPresented:presenting:)` to drive the
/// "Block @handle?" confirmation dialog.
struct BlockTargetIdentifier: Identifiable, Equatable {
    let userId: String
    let handle: String

    var id: String { userId }
}

enum ReportReason: String, Codable, CaseIterable, Identifiable {
    case spam
    case harassment
    case hate
    case sexual
    case violence
    case other

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .spam:       return "Spam or scam"
        case .harassment: return "Harassment or bullying"
        case .hate:       return "Hate speech"
        case .sexual:     return "Sexual or adult content"
        case .violence:   return "Violence or threats"
        case .other:      return "Something else"
        }
    }
}

// MARK: - APIClient extension

/// Wire shape of one blocked-user row returned by GET /api/moderation/blocks.
struct BlockedUserEntry: Decodable, Identifiable {
    let blockedId: String
    let blockedHandle: String?
    let createdAt: String

    var id: String { blockedId }
    var displayHandle: String { blockedHandle ?? "user" }
}

extension APIClient {
    private struct OkResponse: Decodable { let ok: Bool }

    private struct BlocksList: Decodable {
        let ok: Bool
        let blocks: [BlockedUserEntry]
    }

    private struct ReportSubmitResponse: Decodable {
        let ok: Bool
        let id: Int?
    }

    /// POST /api/moderation/blocks (by clerk_user_id — preferred)
    static func blockUser(_ blockedClerkUserId: String) async throws {
        let _: OkResponse = try await post(
            path: "/api/moderation/blocks",
            body: ["blocked_id": blockedClerkUserId],
        )
    }

    /// POST /api/moderation/blocks (by handle — used from profile views).
    /// Server resolves handle → clerk_user_id via resolve_profile_handle.
    static func blockUser(handle: String) async throws {
        let _: OkResponse = try await post(
            path: "/api/moderation/blocks",
            body: ["blocked_handle": handle],
        )
    }

    /// DELETE /api/moderation/blocks?blocked_id=
    static func unblockUser(_ blockedClerkUserId: String) async throws {
        let _: OkResponse = try await delete(
            path: "/api/moderation/blocks",
            query: [("blocked_id", blockedClerkUserId)],
        )
    }

    /// GET /api/moderation/blocks
    /// Returns the set of clerk_user_ids the current user has blocked.
    static func listBlockedUserIds() async throws -> Set<String> {
        let res: BlocksList = try await get(path: "/api/moderation/blocks")
        return Set(res.blocks.map { $0.blockedId })
    }

    /// GET /api/moderation/blocks (full payload with handles).
    /// Used by Settings → Blocked Users to render a manageable list.
    static func listBlockedUsers() async throws -> [BlockedUserEntry] {
        let res: BlocksList = try await get(path: "/api/moderation/blocks")
        return res.blocks
    }

    /// POST /api/moderation/reports
    static func reportContent(
        targetKind: ReportTargetKind,
        targetId: String,
        reason: ReportReason,
        details: String?,
    ) async throws {
        var body: [String: Any] = [
            "target_kind": targetKind.rawValue,
            "target_id": targetId,
            "reason": reason.rawValue,
        ]
        if let trimmed = details?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            body["details"] = trimmed
        }
        let _: ReportSubmitResponse = try await post(
            path: "/api/moderation/reports",
            body: body,
        )
    }

    /// POST /api/moderation/reports for a profile report by handle.
    /// Server resolves handle → clerk_user_id; target_kind is fixed to
    /// "profile" so the wire shape matches the comment/event paths.
    static func reportProfile(
        handle: String,
        reason: ReportReason,
        details: String?,
    ) async throws {
        var body: [String: Any] = [
            "target_kind": ReportTargetKind.profile.rawValue,
            "target_handle": handle,
            "reason": reason.rawValue,
        ]
        if let trimmed = details?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            body["details"] = trimmed
        }
        let _: ReportSubmitResponse = try await post(
            path: "/api/moderation/reports",
            body: body,
        )
    }
}

// MARK: - BlockedUsersStore
//
// Observable cache so any view can ask "is this user blocked by me?"
// without an extra round-trip per render. Refreshed on app launch and
// after every block/unblock action.

@MainActor
final class BlockedUsersStore: ObservableObject {
    static let shared = BlockedUsersStore()

    @Published private(set) var blockedUserIds: Set<String> = []

    private init() {}

    func isBlocked(_ clerkUserId: String?) -> Bool {
        guard let id = clerkUserId, !id.isEmpty else { return false }
        return blockedUserIds.contains(id)
    }

    /// Pulls the latest server-side block list. Safe to call on app
    /// launch + after sign-in. Errors are swallowed — server-side
    /// filtering is authoritative; the local cache only hides content
    /// faster.
    func refresh() async {
        do {
            let ids = try await APIClient.listBlockedUserIds()
            self.blockedUserIds = ids
        } catch {
            Logger.api.debug("[moderation] block-list refresh failed: \(String(describing: error))")
        }
    }

    /// Optimistic add — updates local cache immediately so blocked
    /// content disappears without waiting for the next refresh.
    func recordBlock(_ clerkUserId: String) {
        blockedUserIds.insert(clerkUserId)
    }

    /// Optimistic remove — used after Settings → Blocked Users → Unblock.
    func recordUnblock(_ clerkUserId: String) {
        blockedUserIds.remove(clerkUserId)
    }

    func clear() {
        blockedUserIds.removeAll()
    }
}
