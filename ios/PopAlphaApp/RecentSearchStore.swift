import Foundation
import SwiftUI

// Persists the cards a user has tapped into from search, so the search
// screen can surface them as "Recent" next time. Local-only (UserDefaults)
// — no server roundtrip, works offline, no auth coupling.
@MainActor
final class RecentSearchStore: ObservableObject {
    static let shared = RecentSearchStore()

    private let storageKey = "popalpha.search.recent.v1"
    private let maxEntries = 10

    @Published private(set) var recents: [SearchCardResult] = []

    private init() {
        load()
    }

    func record(_ card: SearchCardResult) {
        recents.removeAll { $0.canonicalSlug == card.canonicalSlug }
        recents.insert(card, at: 0)
        if recents.count > maxEntries {
            recents = Array(recents.prefix(maxEntries))
        }
        save()
    }

    func remove(slug: String) {
        recents.removeAll { $0.canonicalSlug == slug }
        save()
    }

    func clear() {
        recents = []
        save()
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey) else { return }
        recents = (try? JSONDecoder().decode([SearchCardResult].self, from: data)) ?? []
    }

    private func save() {
        if let data = try? JSONEncoder().encode(recents) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
}
