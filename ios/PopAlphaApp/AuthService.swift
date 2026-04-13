import Foundation

// MARK: - Auth Service Stub (replace internals when Clerk iOS SDK is integrated)

@Observable
final class AuthService {
    static let shared = AuthService()

    private(set) var isAuthenticated: Bool = false
    private(set) var authToken: String?
    private(set) var currentUserId: String?
    private(set) var currentHandle: String?

    private init() {}

    // MARK: - Auth Actions (stubs)

    /// Placeholder — will be replaced with Clerk iOS sign-in flow
    func signIn() {
        // TODO: Integrate Clerk iOS SDK
        // 1. Present Clerk sign-in sheet
        // 2. On success, set authToken, currentUserId, currentHandle
        // 3. Call APIClient.setAuthToken(token)
        // 4. Start NotificationService polling
    }

    func signOut() {
        isAuthenticated = false
        authToken = nil
        currentUserId = nil
        currentHandle = nil
        APIClient.setAuthToken(nil)
    }

    // MARK: - Token management (called by Clerk integration)

    func setSession(token: String, userId: String, handle: String?) {
        authToken = token
        currentUserId = userId
        currentHandle = handle
        isAuthenticated = true
        APIClient.setAuthToken(token)
    }

    // MARK: - Auth guard helper

    func requireAuth() throws {
        guard isAuthenticated else {
            throw APIError.unauthorized
        }
    }
}
