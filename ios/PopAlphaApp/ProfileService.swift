import Foundation

// MARK: - Profile Service — Profile, follows, and posts

actor ProfileService {
    static let shared = ProfileService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: - Models

    struct UserProfile: Decodable {
        let handle: String
        let onboarded: Bool
        let createdAt: String
        let profileBio: String?
        let profileBannerUrl: String?
    }

    struct ProfilePost: Decodable, Identifiable {
        let id: Int
        let body: String
        let createdAt: String
        let mentions: [PostMention]?
    }

    struct PostMention: Decodable {
        let canonicalSlug: String
        let mentionText: String
        let startIndex: Int
        let endIndex: Int
    }

    struct ProfileStats: Decodable {
        let postCount: Int
        let followerCount: Int
        let followingCount: Int
    }

    // MARK: - Response Wrappers

    private struct ProfileResponse: Decodable {
        let ok: Bool
        let profile: UserProfile
        let posts: [ProfilePost]?
        let stats: ProfileStats?
    }

    private struct FollowCheckResponse: Decodable {
        let ok: Bool
        let following: Bool
    }

    private struct SimpleResponse: Decodable {
        let ok: Bool
    }

    private struct PostResponse: Decodable {
        let ok: Bool
        let post: ProfilePost?
    }

    // MARK: - Profile

    /// Fetch current user's profile
    func fetchMyProfile() async throws -> (profile: UserProfile, posts: [ProfilePost], stats: ProfileStats) {
        try AuthService.shared.requireAuth()

        let response: ProfileResponse = try await APIClient.get(
            path: "/api/profile",
            decoder: decoder
        )

        return (
            response.profile,
            response.posts ?? [],
            response.stats ?? ProfileStats(postCount: 0, followerCount: 0, followingCount: 0)
        )
    }

    /// Update handle and/or bio
    func updateProfile(handle: String?, bio: String?) async throws {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = [:]
        if let handle { body["handle"] = handle }
        if let bio { body["profileBio"] = bio }

        let _: SimpleResponse = try await APIClient.patch(
            path: "/api/profile",
            body: body,
            decoder: decoder
        )
    }

    // MARK: - Follow System

    /// Check if current user follows the given handle
    func isFollowing(handle: String) async throws -> Bool {
        try AuthService.shared.requireAuth()

        let response: FollowCheckResponse = try await APIClient.get(
            path: "/api/profile/follow",
            query: [("handle", handle)],
            decoder: decoder
        )
        return response.following
    }

    /// Follow a user by handle
    func followUser(handle: String) async throws {
        try AuthService.shared.requireAuth()

        let _: SimpleResponse = try await APIClient.post(
            path: "/api/profile/follow",
            body: ["handle": handle],
            decoder: decoder
        )
    }

    /// Unfollow a user by handle
    func unfollowUser(handle: String) async throws {
        try AuthService.shared.requireAuth()

        let _: SimpleResponse = try await APIClient.delete(
            path: "/api/profile/follow",
            query: [("handle", handle)],
            decoder: decoder
        )
    }

    // MARK: - Posts

    /// Create a new profile post (280 char max, supports /Card/ mentions)
    func createPost(body: String) async throws -> ProfilePost? {
        try AuthService.shared.requireAuth()

        let response: PostResponse = try await APIClient.post(
            path: "/api/profile/posts",
            body: ["body": body],
            decoder: decoder
        )
        return response.post
    }
}
