import Foundation

// MARK: - PopAlpha API Client (calls Next.js routes at popalpha.ai)

enum APIClient {
    static let baseURL = "https://popalpha.ai"

    // MARK: - Auth token (set by AuthService when available)

    private static var _authToken: String?

    static func setAuthToken(_ token: String?) {
        _authToken = token
    }

    // MARK: - HTTP Methods

    static func get<T: Decodable>(
        path: String,
        query: [(String, String)] = [],
        decoder: JSONDecoder? = nil
    ) async throws -> T {
        let url = try buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyHeaders(&request)
        return try await execute(request, decoder: decoder)
    }

    static func post<T: Decodable>(
        path: String,
        body: [String: Any],
        decoder: JSONDecoder? = nil
    ) async throws -> T {
        let url = try buildURL(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        applyHeaders(&request)
        return try await execute(request, decoder: decoder)
    }

    static func patch<T: Decodable>(
        path: String,
        body: [String: Any],
        decoder: JSONDecoder? = nil
    ) async throws -> T {
        let url = try buildURL(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        applyHeaders(&request)
        return try await execute(request, decoder: decoder)
    }

    static func delete<T: Decodable>(
        path: String,
        query: [(String, String)] = [],
        decoder: JSONDecoder? = nil
    ) async throws -> T {
        let url = try buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyHeaders(&request)
        return try await execute(request, decoder: decoder)
    }

    /// POST with a raw byte body (e.g. JPEG from the camera scanner).
    /// Content-Type is supplied by the caller. Response is decoded as JSON.
    /// Used by the scanner identify path, which can't JSON-encode the
    /// image without a 33% base64 overhead on every scan.
    static func postRaw<T: Decodable>(
        path: String,
        body: Data,
        contentType: String,
        query: [(String, String)] = [],
        decoder: JSONDecoder? = nil
    ) async throws -> T {
        let url = try buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        applyHeaders(&request)
        // applyHeaders set application/json; override for binary payloads.
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        return try await execute(request, decoder: decoder)
    }

    /// Fire-and-forget POST (no response body needed for success path).
    /// On error responses we still capture the response body so callers
    /// can log it — without this, every server-side failure surfaces as
    /// `body=""`, making remote debugging impossible.
    static func post(path: String, body: [String: Any]) async throws {
        let url = try buildURL(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        applyHeaders(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.httpError(statusCode: 0, body: "No HTTP response")
        }
        if http.statusCode == 401 {
            throw APIError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            let bodyText = String(data: data, encoding: .utf8) ?? ""
            throw APIError.httpError(
                statusCode: http.statusCode,
                body: String(bodyText.prefix(500))
            )
        }
    }

    // MARK: - Internals

    private static func buildURL(path: String, query: [(String, String)] = []) throws -> URL {
        var components = URLComponents(string: "\(baseURL)\(path)")!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
        }
        guard let url = components.url else {
            throw APIError.invalidURL(path)
        }
        return url
    }

    private static func applyHeaders(_ request: inout URLRequest) {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = _authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // Personalization actor identity — cookies are not sent from native
        // clients, so we attach the locally-persisted key on every request.
        // Server picks Clerk > cookie > header > fresh-mint, so this is safe
        // to include even when signed in.
        request.setValue(ActorStore.shared.actorKey, forHTTPHeaderField: "X-PA-Actor-Key")
        // Platform tag — powers server-side telemetry segmentation (e.g.
        // distinguishing iOS scanner traffic from web tests). Harmless
        // if the endpoint doesn't care.
        request.setValue("ios", forHTTPHeaderField: "X-PA-Client-Platform")
        request.cachePolicy = .reloadRevalidatingCacheData
    }

    private static let sharedDecoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static func execute<T: Decodable>(_ request: URLRequest, decoder: JSONDecoder?) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.httpError(statusCode: 0, body: "No HTTP response")
        }

        if http.statusCode == 401 {
            throw APIError.unauthorized
        }

        guard (200...299).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.httpError(statusCode: http.statusCode, body: String(body.prefix(300)))
        }

        do {
            return try (decoder ?? sharedDecoder).decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }
}

// MARK: - Error Type

enum APIError: LocalizedError {
    case httpError(statusCode: Int, body: String)
    case unauthorized
    case invalidURL(String)
    case decodingError(String)

    var errorDescription: String? {
        switch self {
        case .httpError(let code, let body):
            return "API HTTP \(code): \(body.prefix(200))"
        case .unauthorized:
            return "Sign in required"
        case .invalidURL(let path):
            return "Invalid URL: \(path)"
        case .decodingError(let msg):
            return "Decode error: \(msg)"
        }
    }
}
