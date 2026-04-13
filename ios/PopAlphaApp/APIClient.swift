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

    /// Fire-and-forget POST (no response body needed)
    static func post(path: String, body: [String: Any]) async throws {
        let url = try buildURL(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        applyHeaders(&request)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            throw APIError.httpError(statusCode: http?.statusCode ?? 0, body: "")
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
