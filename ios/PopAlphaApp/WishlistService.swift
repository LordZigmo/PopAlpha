import Foundation

// MARK: - Wishlist Service — Server-synced wishlist via PopAlpha API

actor WishlistService {
    static let shared = WishlistService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // MARK: - Models (matches /api/wishlist JSON contract)

    struct WishlistItem: Decodable, Identifiable, Hashable {
        let id: Int
        let canonicalSlug: String
        let note: String?
        let createdAt: String
        let canonicalName: String?
        let setName: String?
        let year: Int?
        let imageUrl: String?

        var displayName: String {
            canonicalName ?? canonicalSlug
        }

        var imageURL: URL? {
            imageUrl.flatMap(URL.init(string:))
        }
    }

    private struct ListResponse: Decodable {
        let ok: Bool
        let items: [WishlistItem]
    }

    private struct MutationResponse: Decodable {
        let ok: Bool
    }

    // MARK: - Local cache (persists to UserDefaults for offline access)

    private let cacheKey = "popalpha_wishlist_cache"

    private func cachedItems() -> [WishlistItem] {
        guard let data = UserDefaults.standard.data(forKey: cacheKey),
              let items = try? decoder.decode([WishlistItem].self, from: data) else {
            return []
        }
        return items
    }

    private func cacheItems(_ items: [WishlistItem]) {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        if let data = try? encoder.encode(items.map(WishlistItemEncodable.init)) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
    }

    /// Encodable mirror of WishlistItem for local caching
    private struct WishlistItemEncodable: Encodable {
        let id: Int
        let canonicalSlug: String
        let note: String?
        let createdAt: String
        let canonicalName: String?
        let setName: String?
        let year: Int?
        let imageUrl: String?

        init(_ item: WishlistItem) {
            self.id = item.id
            self.canonicalSlug = item.canonicalSlug
            self.note = item.note
            self.createdAt = item.createdAt
            self.canonicalName = item.canonicalName
            self.setName = item.setName
            self.year = item.year
            self.imageUrl = item.imageUrl
        }
    }

    // MARK: - API Methods

    /// Fetch the user's wishlist from the server, with local cache fallback.
    func fetchWishlist() async throws -> [WishlistItem] {
        guard AuthService.shared.isAuthenticated else {
            return cachedItems()
        }

        let response: ListResponse = try await APIClient.get(
            path: "/api/wishlist",
            decoder: decoder
        )

        guard response.ok else { return cachedItems() }

        // Update local cache
        cacheItems(response.items)
        return response.items
    }

    /// Add a card to the wishlist.
    func addItem(slug: String, note: String? = nil) async throws -> Bool {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = ["canonical_slug": slug]
        if let note { body["note"] = note }

        let response: MutationResponse = try await APIClient.post(
            path: "/api/wishlist",
            body: body,
            decoder: decoder
        )
        return response.ok
    }

    /// Remove a card from the wishlist.
    func removeItem(slug: String) async throws -> Bool {
        try AuthService.shared.requireAuth()

        let response: MutationResponse = try await APIClient.delete(
            path: "/api/wishlist",
            query: [("slug", slug)],
            decoder: decoder
        )
        return response.ok
    }

    /// Check if a card is on the wishlist (from cache).
    func isWishlisted(slug: String) -> Bool {
        return cachedItems().contains(where: { $0.canonicalSlug == slug })
    }
}
