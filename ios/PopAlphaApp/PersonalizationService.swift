import Foundation

// MARK: - Actor Store
//
// Mirrors the web `pa_actor` cookie. The value is a stable, locally-persisted
// guest identifier of the form `guest:<uuid>`. When the user is signed in via
// Clerk, the server ignores this header in favor of the Clerk user id, so this
// key is safe to send on every request regardless of auth state.

final class ActorStore {
    static let shared = ActorStore()

    private let defaults: UserDefaults
    private let key = "popalpha.personalization.actorKey.v1"
    private let queue = DispatchQueue(label: "popalpha.personalization.actorStore")
    private var cached: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var actorKey: String {
        queue.sync {
            if let existing = cached, Self.isValid(existing) {
                return existing
            }
            if let stored = defaults.string(forKey: key), Self.isValid(stored) {
                cached = stored
                return stored
            }
            let fresh = "guest:\(UUID().uuidString.lowercased())"
            defaults.set(fresh, forKey: key)
            cached = fresh
            return fresh
        }
    }

    /// Replace the current key — used by the server when it returns a canonical
    /// actor_key (e.g. after claiming a guest onto a signed-in user).
    func set(_ newValue: String) {
        queue.sync {
            guard Self.isValid(newValue) else { return }
            cached = newValue
            defaults.set(newValue, forKey: key)
        }
    }

    private static func isValid(_ value: String) -> Bool {
        guard value.count >= 10, value.count <= 200 else { return false }
        return value.hasPrefix("guest:") || value.hasPrefix("user:")
    }
}

// MARK: - API Models
//
// Mirror the JSON contract returned by:
//   GET /api/personalization/profile
//   GET /api/personalization/explanation
//   POST /api/personalization/events

struct PersonalizedExplanation: Decodable {
    let headline: String
    let summary: String
    let whyItMatches: String
    let reasons: [String]
    let caveats: [String]
    let confidence: Double
    let fits: String           // "aligned" | "neutral" | "contrast"
    let generatedAt: String
    let source: String         // "template" | "llm" | "fallback"
    let sourceVersion: String
}

struct PersonalizedProfileSummary: Decodable {
    let dominantStyleLabel: String
    let supportingTraits: [String]
    let confidence: Double
    let eventCount: Int
}

struct PersonalizedExplanationResponse: Decodable {
    let ok: Bool
    let enabled: Bool?
    let mode: String?          // "template" | "llm"
    let explanation: PersonalizedExplanation?
    let profileSummary: PersonalizedProfileSummary?
}

struct PersonalizedProfile: Decodable {
    let actorKey: String
    let dominantStyleLabel: String?
    let supportingTraits: [String]
    let summary: String?
    let confidence: Double
    let eventCount: Int
    let version: Int
    let updatedAt: String
}

struct PersonalizedProfileResponse: Decodable {
    let ok: Bool
    let enabled: Bool?
    let mode: String?
    let profile: PersonalizedProfile?
    let actorKey: String?
    let clerkUserId: String?
}

struct PersonalizedEventsResponse: Decodable {
    let ok: Bool
    let inserted: Int?
}

// MARK: - Event payloads

struct PersonalizedEvent {
    let type: EventType
    let canonicalSlug: String?
    let printingId: String?
    let variantRef: String?
    let payload: [String: String]
    let occurredAt: Date

    enum EventType: String {
        case cardView = "card_view"
        case cardSearchClick = "card_search_click"
        case watchlistAdd = "watchlist_add"
        case collectionAdd = "collection_add"
        case variantSwitch = "variant_switch"
        case marketSignalExpand = "market_signal_expand"
        case aiAnalysisExpand = "ai_analysis_expand"
        case priceHistoryExpand = "price_history_expand"
        case compareOpen = "compare_open"
        case portfolioOpen = "portfolio_open"
    }

    init(
        type: EventType,
        canonicalSlug: String? = nil,
        printingId: String? = nil,
        variantRef: String? = nil,
        payload: [String: String] = [:],
        occurredAt: Date = Date()
    ) {
        self.type = type
        self.canonicalSlug = canonicalSlug
        self.printingId = printingId
        self.variantRef = variantRef
        self.payload = payload
        self.occurredAt = occurredAt
    }

    var jsonBody: [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var body: [String: Any] = [
            "event_type": type.rawValue,
            "occurred_at": formatter.string(from: occurredAt),
            "payload": payload,
        ]
        body["canonical_slug"] = canonicalSlug as Any?
        body["printing_id"] = printingId as Any?
        body["variant_ref"] = variantRef as Any?
        return body
    }
}

// MARK: - Service

actor PersonalizationService {
    static let shared = PersonalizationService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    // Simple in-flight throttling: buffer events for up to 3 seconds then flush.
    private var buffer: [PersonalizedEvent] = []
    private var flushTask: Task<Void, Never>?
    private let flushDelay: TimeInterval = 3.0
    private let maxBuffer = 50

    /// Fire a behavior event. Best-effort, debounced, batched.
    func track(_ event: PersonalizedEvent) {
        buffer.append(event)
        if buffer.count >= maxBuffer {
            flushTask?.cancel()
            flushTask = nil
            Task { await self.flush() }
            return
        }
        if flushTask == nil {
            flushTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(self?.flushDelay ?? 3) * 1_000_000_000)
                await self?.flush()
            }
        }
    }

    /// Flush any buffered events now. Safe to call manually (e.g. on app backgrounding).
    func flush() async {
        let events = buffer
        buffer.removeAll()
        flushTask = nil
        guard !events.isEmpty else { return }
        do {
            let _: PersonalizedEventsResponse = try await APIClient.post(
                path: "/api/personalization/events",
                body: ["events": events.map { $0.jsonBody }],
                decoder: decoder
            )
        } catch {
            // Best-effort — drop silently so tracking never blocks or spams.
        }
    }

    /// Fetch the personalized explanation for a card/variant.
    /// Returns nil on failure (caller renders no insight).
    func fetchExplanation(slug: String, variantRef: String?) async -> PersonalizedExplanationResponse? {
        var query: [(String, String)] = [("slug", slug)]
        if let variantRef, !variantRef.isEmpty {
            query.append(("variant_ref", variantRef))
        }
        do {
            let response: PersonalizedExplanationResponse = try await APIClient.get(
                path: "/api/personalization/explanation",
                query: query,
                decoder: decoder
            )
            return response
        } catch {
            return nil
        }
    }

    /// Fetch the actor's current style profile.
    func fetchProfile() async -> PersonalizedProfileResponse? {
        do {
            let response: PersonalizedProfileResponse = try await APIClient.get(
                path: "/api/personalization/profile",
                decoder: decoder
            )
            if let serverActorKey = response.actorKey {
                ActorStore.shared.set(serverActorKey)
            }
            return response
        } catch {
            return nil
        }
    }
}
