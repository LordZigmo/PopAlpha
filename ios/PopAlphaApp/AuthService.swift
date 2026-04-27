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

    // MARK: - Sign In (providers)
    //
    // Two providers today:
    //   • Google — browser OAuth via ASWebAuthenticationSession. Requires
    //     the redirect URL `{bundleIdentifier}://callback` to be allow-
    //     listed in the Clerk Dashboard → Native Applications.
    //   • Apple  — native AuthenticationServices. No redirect URL
    //     plumbing; requires the "Sign in with Apple" capability on the
    //     app target and Apple enabled as a provider in Clerk Dashboard.
    //
    // Both share the same isSigningIn guard so a user can't trigger both
    // in parallel, and both feed the same signInError surface so the
    // global alert in ContentView works uniformly regardless of provider.

    /// Triggers Google OAuth. Fire-and-forget — spawns its own Task so
    /// SwiftUI button actions stay synchronous.
    func signIn() {
        guard !isSigningIn else { return }
        Task { @MainActor in
            await performSignIn(
                provider: "google",
                { try await Clerk.shared.auth.signInWithOAuth(provider: .google) }
            )
        }
    }

    /// Triggers native Apple Sign In. No webview, no redirect URI —
    /// `AuthenticationServices` handles the credential exchange and
    /// Clerk trades the Apple id_token for a session under the hood.
    func signInWithApple() {
        guard !isSigningIn else { return }
        Task { @MainActor in
            await performSignIn(
                provider: "apple",
                { try await Clerk.shared.auth.signInWithApple() }
            )
        }
    }

    /// Shared post-provider session plumbing: runs the provider-specific
    /// Clerk call, then extracts the session token + user metadata and
    /// wires everything into APIClient. Error handling is the same for
    /// both providers — user-cancel becomes a no-op so the global alert
    /// doesn't fire for a benign dismissal.
    @MainActor
    private func performSignIn(
        provider: String,
        _ providerCall: @escaping () async throws -> Void
    ) async {
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }

        do {
            try await providerCall()

            guard let token = try await Clerk.shared.auth.getToken() else {
                signInError = "Unable to retrieve session token."
                return
            }

            let userId = Clerk.shared.user?.id ?? ""
            let firstName = Clerk.shared.user?.firstName
            let email = Clerk.shared.user?.primaryEmailAddress?.emailAddress
            let imageUrl = Clerk.shared.user?.imageUrl
            setSession(token: token, userId: userId, handle: nil)
            currentFirstName = firstName
            currentImageURL = imageUrl
            startTokenRefresh()

            // Attribute subsequent PostHog events to this Clerk user so
            // iOS activity lands on the same person as the user's web
            // sessions, then capture the sign-in itself.
            if !userId.isEmpty {
                AnalyticsService.shared.identify(
                    userId: userId,
                    email: email,
                    firstName: firstName
                )
                AnalyticsService.shared.capture(
                    .userSignedIn,
                    properties: ["provider": provider]
                )
            }

            await loadHandle()

            // Ask for push permission *after* sign-in succeeds —
            // better conversion than prompting on cold launch, and the
            // register endpoint requires an authenticated session anyway.
            await PushService.shared.requestAuthorizationIfNeeded()
        } catch {
            // User-cancel is a non-error path for both providers:
            //   • ASWebAuthenticationSession (Google) throws its own
            //     "canceledLogin" error (code 1)
            //   • ASAuthorizationError (Apple) throws code 1001 "canceled"
            let ns = error as NSError
            let isUserCancel =
                (ns.domain == "com.apple.AuthenticationServices.WebAuthenticationSession" && ns.code == 1)
                || (ns.domain == "com.apple.AuthenticationServices.AuthorizationError" && ns.code == 1001)
                || error.localizedDescription.lowercased().contains("cancel")
            if !isUserCancel {
                signInError = error.localizedDescription
            }
            print("[AuthService] Sign-in failed: \(error)")
        }
    }

    /// Clear a stale sign-in error after the UI has shown it.
    /// Called from the global alert's dismiss button in ContentView.
    func clearSignInError() {
        signInError = nil
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
        // Force PushService to re-upload on next sign-in so we never
        // send pushes to a signed-out account's token accidentally.
        PushService.shared.clearUploadedTokenCache()
        // Capture the sign-out event *before* reset so it's still
        // attributed to the user who signed out, then reset to a fresh
        // anonymous distinct_id for subsequent events.
        AnalyticsService.shared.capture(.userSignedOut)
        AnalyticsService.shared.reset()
    }

    // MARK: - Session Restoration (cold launch)

    /// Called once on app launch via `.task` in PopAlphaApp.
    /// If Clerk has a cached session, restore auth state without
    /// re-presenting the OAuth flow.
    func restoreSession() async {
        // Clerk.configure() returns synchronously but the SDK loads
        // client + environment in the background. getToken() is
        // unreliable until isLoaded == true.
        await waitForClerkLoaded()

        let user = await Clerk.shared.user
        let session = await Clerk.shared.session
        let clientSessions = await Clerk.shared.client?.sessions ?? []
        print("[AuthService] restore: user=\(user?.id ?? "nil") session=\(session?.id ?? "nil") clientSessions=\(clientSessions.count)")

        // Healthy path: user + active session + token mint succeeds.
        if let user,
           !user.id.isEmpty,
           let session,
           let token = try? await session.getToken(),
           !token.isEmpty {
            await applyHealthyRestore(user: user, token: token)
            return
        }

        // Unhealthy path. Either user is nil but the client still has an
        // orphan credential (Clerk responds "session_exists" to signIn),
        // user is non-nil but session is dead, or token mint fails.
        // Either way, every signIn attempt will 400 and every API call
        // will 401 until we explicitly tear down what's on the client.
        if user != nil || !clientSessions.isEmpty {
            print("[AuthService] restore: limbo — clearing client (sessions=\(clientSessions.count))")
            do {
                try await Clerk.shared.auth.signOut()
                print("[AuthService] signOut(all) ok")
            } catch {
                print("[AuthService] signOut(all) failed: \(error)")
            }
            for s in clientSessions {
                do {
                    try await Clerk.shared.auth.signOut(sessionId: s.id)
                    print("[AuthService] signOut(sessionId: \(s.id)) ok")
                } catch {
                    print("[AuthService] signOut(sessionId: \(s.id)) failed: \(error)")
                }
            }
        }
        return
    }

    /// Apply a successful cold-launch restore to local state and kick
    /// off the side-effects (handle fetch, push registration, analytics).
    /// Pulled out of `restoreSession` so the healthy path stays linear.
    private func applyHealthyRestore(user: User, token: String) async {
        let userId = user.id
        let firstName = user.firstName
        let email = user.primaryEmailAddress?.emailAddress
        let imageUrl = user.imageUrl

        await MainActor.run {
            setSession(token: token, userId: userId, handle: nil)
            currentFirstName = firstName
            currentImageURL = imageUrl
            startTokenRefresh()
        }

        // Re-identify on cold launch so events from this session
        // attribute to the correct user. No signed-in event is fired
        // here — the user didn't just sign in, they returned.
        AnalyticsService.shared.identify(
            userId: userId,
            email: email,
            firstName: firstName
        )

        await loadHandle()

        // Returning user with a cached Clerk session — re-trigger APNs
        // registration so the server gets a fresh device token every
        // cold launch. PushService dedupes if the token hasn't rotated.
        await PushService.shared.requestAuthorizationIfNeeded()
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
            // Refresh immediately so the first authed request after
            // cold launch / sign-in goes out with a fresh JWT, then
            // settle into the 50s steady-state cadence. Without this,
            // the first portfolio fetch races a stale cached token.
            await self?.refreshTokenIfNeeded()
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

    // MARK: - Clerk Readiness

    /// Spin until Clerk's background load (environment + client) finishes
    /// or we hit the timeout. Past the timeout, callers fall back to the
    /// signed-out path — better than wedging the app on a Clerk outage.
    private func waitForClerkLoaded(timeout: Duration = .seconds(8)) async {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if await Clerk.shared.isLoaded { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    // MARK: - Server-Driven Auth Reconciliation

    /// Called from APIClient when the server returns 401 despite us
    /// believing we're authenticated. Most 401s are just expired tokens
    /// — try a fresh getToken() first. If Clerk has nothing usable, we
    /// have to also tear down Clerk's client-side session(s); otherwise
    /// the next signIn attempt 400s with `session_exists` because Clerk
    /// thinks the user is still signed in even though our server doesn't.
    @MainActor
    func handleServerAuthRejection() async {
        if let token = try? await Clerk.shared.auth.getToken(),
           !token.isEmpty,
           token != authToken {
            print("[AuthService] 401 → minted fresh token, retrying")
            authToken = token
            APIClient.setAuthToken(token)
            return
        }
        print("[AuthService] 401 → no usable token from Clerk, tearing down")
        isAuthenticated = false
        authToken = nil
        APIClient.setAuthToken(nil)

        // Same cleanup as the cold-launch limbo path. Without this, the
        // user is stuck: local state says signed-out, Clerk says they're
        // still signed in, signIn rejects with session_exists.
        let sessions = Clerk.shared.client?.sessions ?? []
        do {
            try await Clerk.shared.auth.signOut()
            print("[AuthService] 401 cleanup: signOut(all) ok")
        } catch {
            print("[AuthService] 401 cleanup: signOut(all) failed: \(error)")
        }
        for s in sessions {
            do {
                try await Clerk.shared.auth.signOut(sessionId: s.id)
                print("[AuthService] 401 cleanup: signOut(\(s.id)) ok")
            } catch {
                print("[AuthService] 401 cleanup: signOut(\(s.id)) failed: \(error)")
            }
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
