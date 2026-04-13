import Foundation

// MARK: - Account Service — Apple-compliant account deletion & data export

actor AccountService {
    static let shared = AccountService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Request permanent deletion of all user data (Apple §5.1.1(v))
    /// Deletes: holdings, wishlist, activity, notifications, profile, push subscriptions
    func requestAccountDeletion() async throws {
        try AuthService.shared.requireAuth()

        let _: SimpleOKResponse = try await APIClient.delete(
            path: "/api/me",
            decoder: decoder
        )

        // Sign out locally after server deletion
        await MainActor.run {
            AuthService.shared.signOut()
            NotificationService.shared.stopPolling()
        }
    }

    /// Export all user data as a JSON bundle
    func exportUserData() async throws -> Data {
        try AuthService.shared.requireAuth()

        // We need raw data, not decoded — so use a manual request
        let url = URL(string: "\(APIClient.baseURL)/api/me/export")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = AuthService.shared.authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            throw APIError.httpError(statusCode: http?.statusCode ?? 0, body: "Export failed")
        }

        return data
    }
}
