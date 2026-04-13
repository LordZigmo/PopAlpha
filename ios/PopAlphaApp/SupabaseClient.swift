import Foundation

// MARK: - Supabase REST Client (lightweight, no SDK dependency)

enum Supabase {
    static let baseURL = "https://nbveknrnvcgeyysqrtkl.supabase.co"
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5idmVrbnJudmNnZXl5c3FydGtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5ODY4NTMsImV4cCI6MjA4NzU2Mjg1M30.22dNHZBM5WaDmOu8dNSMdpSY61VtA_QH_Ett5xCEDPU"

    static let restURL = "\(baseURL)/rest/v1"

    static var defaultHeaders: [String: String] {
        [
            "apikey": anonKey,
            "Authorization": "Bearer \(anonKey)",
            "Content-Type": "application/json",
            "Accept": "application/json",
        ]
    }

    /// Execute a Supabase PostgREST query
    static func query(
        table: String,
        select: String,
        filters: [(column: String, op: String, value: String)] = [],
        order: String? = nil,
        limit: Int? = nil
    ) async throws -> Data {
        var components = URLComponents(string: "\(restURL)/\(table)")!
        var queryItems = [URLQueryItem(name: "select", value: select)]

        for filter in filters {
            queryItems.append(URLQueryItem(name: filter.column, value: "\(filter.op).\(filter.value)"))
        }

        if let order {
            queryItems.append(URLQueryItem(name: "order", value: order))
        }

        if let limit {
            queryItems.append(URLQueryItem(name: "limit", value: String(limit)))
        }

        components.queryItems = queryItems

        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        for (key, value) in defaultHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.cachePolicy = .reloadRevalidatingCacheData

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            throw SupabaseError.httpError(statusCode: http?.statusCode ?? 0, body: String(data: data, encoding: .utf8) ?? "")
        }

        return data
    }

    /// HEAD request with exact count (returns count from Content-Range header)
    static func count(
        table: String,
        filters: [(column: String, op: String, value: String)] = []
    ) async throws -> Int {
        var components = URLComponents(string: "\(restURL)/\(table)")!
        var queryItems = [URLQueryItem(name: "select", value: "canonical_slug")]

        for filter in filters {
            queryItems.append(URLQueryItem(name: filter.column, value: "\(filter.op).\(filter.value)"))
        }

        components.queryItems = queryItems

        var request = URLRequest(url: components.url!)
        request.httpMethod = "HEAD"
        for (key, value) in defaultHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.setValue("count=exact", forHTTPHeaderField: "Prefer")
        request.cachePolicy = .reloadRevalidatingCacheData

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            throw SupabaseError.httpError(statusCode: http?.statusCode ?? 0, body: "HEAD failed")
        }

        // Parse Content-Range: 0-0/1234 → extract total after "/"
        if let contentRange = http.value(forHTTPHeaderField: "Content-Range"),
           let slashIdx = contentRange.lastIndex(of: "/") {
            let totalStr = contentRange[contentRange.index(after: slashIdx)...]
            return Int(totalStr) ?? 0
        }

        return 0
    }
}

enum SupabaseError: LocalizedError {
    case httpError(statusCode: Int, body: String)
    case decodingError(String)

    var errorDescription: String? {
        switch self {
        case .httpError(let code, let body):
            return "Supabase HTTP \(code): \(body.prefix(200))"
        case .decodingError(let msg):
            return "Decode error: \(msg)"
        }
    }
}
