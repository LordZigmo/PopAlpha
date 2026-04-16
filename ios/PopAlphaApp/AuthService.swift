import Foundation
import ClerkKit

// MARK: - Auth Service (Clerk iOS SDK)
//
// Wraps the Clerk iOS SDK to provide Google OAuth sign-in.
// Public API (signIn, signOut, isAuthenticated, authToken, etc.)
// is unchanged from the stub — all existing call sites continue to
// work without modification.

@Observable
final class AuthService {
    static let shared = AuthService()

    private(set) var isAuthenticated: Bool = false
    private(set) var authToken: String?
    private(set) var currentUserId: String?
    private(set) var currentHandle: String?
    private(set) var currentFirstName: String?
    private(set) var currentImageURL: String?
    private(set) var isSigningIn: Bool = false
    private(set) var signInError: String?

    private var tokenRefreshTask: Task<Void, Never>?

    private init() {}

    // MARK: - Sign In (Google OAuth via Clerk)

    /// Triggers Google OAuth. Existing call sites fire-and-forget —
    /// the method spawns its own Task so callers stay synchronous.
    func signIn() {
        guard !isSigningIn else { return }
        Task { @MainActor in
            await performSignIn()
        }
    }

    @MainActor
    private func performSignIn() async {
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }

        do {
            // Clerk presents ASWebAuthenticationSession for Google OAuth.
            _ = try await Clerk.shared.auth.signInWithOAuth(provider: .google)

            // Extract session token + user ID from the now-active session.
            guard let token = try await Clerk.shared.auth.getToken() else {
                signInError = "Unable to retrieve session token."
                return
            }

            let userId = await Clerk.shared.user?.id ?? ""
            let firstName = await Clerk.shared.user?.firstName
            let imageUrl = await Clerk.shared.user?.imageUrl
            setSession(token: token, userId: userId, handle: nil)
            currentFirstName = firstName
            currentImageURL = imageUrl
            startTokenRefresh()

            // Fetch the user's handle from the API (lives in our DB, not Clerk).
            await loadHandle()
        } catch {
            signInError = error.localizedDescription
            print("[AuthService] Sign-in failed: \(error)")
        }
    }

    // MARK: - Sign Out

    func signOut() {
        Task {
            try? await Clerk.shared.auth.signOut()
        }
        stopTokenRefresh()
        isAuthenticated = false
        authToken = nil
        currentUserId = nil
        currentHandle = nil
        currentFirstName = nil
        currentImageURL = nil
        APIClient.setAuthToken(nil)
    }

    // MARK: - Session Restoration (cold launch)

    /// Called once on app launch via `.task` in PopAlphaApp.
    /// If Clerk has a cached session, restore auth state without
    /// re-presenting the OAuth flow.
    func restoreSession() async {
        guard let token = try? await Clerk.shared.auth.getToken() else { return }
        let userId = await Clerk.shared.user?.id ?? ""
        guard !userId.isEmpty else { return }
        let firstName = await Clerk.shared.user?.firstName
        let imageUrl = await Clerk.shared.user?.imageUrl

        await MainActor.run {
            setSession(token: token, userId: userId, handle: nil)
            currentFirstName = firstName
            currentImageURL = imageUrl
            startTokenRefresh()
        }

        await loadHandle()
    }

    // MARK: - Token Refresh

    /// Clerk JWTs are short-lived (~60s). This background loop
    /// fetches a fresh token every 50s to keep APIClient in sync.
    func refreshTokenIfNeeded() async {
        guard isAuthenticated else { return }
        if let token = try? await Clerk.shared.auth.getToken() {
            await MainActor.run {
                authToken = token
                APIClient.setAuthToken(token)
            }
        }
    }

    private func startTokenRefresh() {
        stopTokenRefresh()
        tokenRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(50))
                guard !Task.isCancelled else { break }
                await self?.refreshTokenIfNeeded()
            }
        }
    }

    private func stopTokenRefresh() {
        tokenRefreshTask?.cancel()
        tokenRefreshTask = nil
    }

    // MARK: - Token Management

    func setSession(token: String, userId: String, handle: String?) {
        authToken = token
        currentUserId = userId
        currentHandle = handle
        isAuthenticated = true
        APIClient.setAuthToken(token)
    }

    // MARK: - Auth Guard

    func requireAuth() throws {
        guard isAuthenticated else {
            throw APIError.unauthorized
        }
    }

    // MARK: - Profile Fetch

    /// Loads the user's handle from /api/me. The handle lives in
    /// our database, not in Clerk user metadata.
    @MainActor
    private func loadHandle() async {
        // /api/me returns { ok, user: { handle, ... } } — handle is nested.
        struct MeUser: Decodable {
            let handle: String?
        }
        struct MeResponse: Decodable {
            let user: MeUser?
        }
        if let me: MeResponse = try? await APIClient.get(path: "/api/me") {
            currentHandle = me.user?.handle
        }
    }
}
