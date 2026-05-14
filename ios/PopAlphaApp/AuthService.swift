import Foundation
import ClerkKit
import OSLog

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

    /// Drives the unified SignInSheet from any "Sign In" CTA. The sheet
    /// presents the three providers (Google / Apple / Email) and runs
    /// the appropriate AuthService method when the user picks one. Set
    /// true by `signIn()`, cleared when the sheet dismisses.
    var showSignInSheet: Bool = false

    /// Which email-code flow was most recently prepared by
    /// `signInWithEmail(_:)`. The sheet's Back button lets a user
    /// switch emails between send-code attempts, which can leave both
    /// `currentSignIn` AND `currentSignUp` populated on Clerk's
    /// client. Dispatching `verifyEmailCode(_:)` on this local state
    /// (instead of on whichever Clerk attempt happens to exist)
    /// guarantees the user's code goes to the flow they last
    /// triggered, not a stale one. Codex P2 #3 on PR #62.
    private enum EmailFlow { case signIn, signUp }
    private var lastEmailFlow: EmailFlow?

    /// Email last passed to `signInWithEmail(_:)`. Paired with
    /// `lastEmailFlow` to decide if a subsequent call is a Resend
    /// for the same address (→ reuse the existing Clerk SignIn /
    /// SignUp attempt) or a fresh attempt for a different address
    /// (→ create new). Codex P2 #4 on PR #62 caught that creating a
    /// new sign-up for a resend on the same email fails with an
    /// "attempt in progress" error and leaves the user unable to
    /// fetch a replacement code.
    private var lastEmailAddress: String?

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

    /// Generic "Sign In" entry point used by every shortcut button in
    /// the app (Settings, Watchlist empty, Portfolio empty, etc.).
    /// Opens the SignInSheet which presents Google / Apple / Email so
    /// users — and App Reviewers — can pick whichever is convenient.
    /// Direct-to-provider entry is still available via
    /// `signInWithGoogle()` / `signInWithApple()` (used by
    /// SignInProviderStack and similar inline 3-button surfaces where
    /// the user's already implicitly chosen).
    @MainActor
    func signIn() {
        guard !isSigningIn else { return }
        showSignInSheet = true
    }

    /// Triggers Google OAuth directly, bypassing the chooser. Used by
    /// PrimarySignInButton inside SignInProviderStack and by the
    /// chooser phase of SignInSheet itself when the user picks Google.
    /// Fire-and-forget — spawns its own Task so SwiftUI button actions
    /// stay synchronous.
    func signInWithGoogle() {
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
    /// Clerk call, then hands off to `onSessionEstablished(provider:)` to
    /// extract the session token + user metadata and wire everything
    /// into APIClient. Error handling is the same for OAuth providers —
    /// user-cancel becomes a no-op so the global alert doesn't fire for
    /// a benign dismissal.
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
            try await onSessionEstablished(provider: provider)
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
            Logger.auth.debug("Sign-in failed: \(error)")
        }
    }

    /// Common plumbing run once a session is established by ANY auth
    /// path (OAuth or email-code). Extracts the Clerk session token +
    /// user metadata, wires APIClient, kicks off the token-refresh
    /// loop, attributes subsequent analytics to the Clerk user, loads
    /// the in-app handle, and surfaces the soft push-permission prompt
    /// for fresh sign-ins. Throws if no token is available — callers
    /// should treat that as a hard failure.
    @MainActor
    private func onSessionEstablished(provider: String) async throws {
        guard let token = try await Clerk.shared.auth.getToken() else {
            throw NSError(
                domain: "PopAlpha.Auth",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to retrieve session token."]
            )
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

        // Soft pre-prompt before the system permission dialog —
        // shows our PushPermissionPromptSheet on first sign-in so
        // the user can say "Not Now" without burning the one-shot
        // system prompt. PushService falls back to the direct
        // requestAuthorizationIfNeeded() path on subsequent
        // sign-ins / when the user has already responded.
        await PushService.shared.maybeShowSoftPrompt()

        // Session is live — clear any in-flight email-code attempt
        // state so the next sign-in starts with a clean slate.
        lastEmailFlow = nil
        lastEmailAddress = nil
    }

    // MARK: - Email code sign-in / sign-up
    //
    // Two-phase: caller invokes signInWithEmail(_:) to send the code,
    // then verifyEmailCode(_:) once the user enters the 6-digit code
    // they received. Errors throw so the SignInSheet can render
    // them inline next to the field rather than via the global alert.
    //
    // The flow handles both sign-in AND sign-up transparently — the
    // user just types their email and gets a code, regardless of
    // whether they have an existing PopAlpha account. Phase 1 tries
    // sign-in first; if Clerk reports the email isn't registered, it
    // falls through to a fresh SignUp so the user can create the
    // account through the same single-step interaction. Phase 2 then
    // dispatches the code at whichever flow is in progress.

    /// Phase 1: ask Clerk to send a verification code to `email`.
    /// Internally tries sign-in first, then sign-up on a not-found
    /// error. Either way, on success the same code-entry phase opens
    /// and verifyEmailCode(_:) completes the flow.
    @MainActor
    func signInWithEmail(_ email: String) async throws {
        guard !isSigningIn else { return }
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(
                domain: "PopAlpha.Auth",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Enter an email address."]
            )
        }

        // Resend path: same email as the most recently prepared
        // attempt → reuse the existing Clerk SignIn / SignUp to
        // send another code on the in-flight attempt rather than
        // creating a new one. Clerk rejects fresh attempts while one
        // is in-progress for the same identifier ("attempt in
        // progress"), so without this branch Resend Code from the
        // SignInSheet code phase breaks for new users. Codex P2 #4
        // on PR #62.
        if lastEmailAddress == trimmed {
            switch lastEmailFlow {
            case .signUp:
                if let signUp = Clerk.shared.auth.currentSignUp {
                    _ = try await signUp.sendEmailCode()
                    return
                }
            case .signIn:
                if let signIn = Clerk.shared.auth.currentSignIn {
                    _ = try await signIn.sendEmailCode()
                    return
                }
            case nil:
                break
            }
            // Fall through to fresh-attempt path if the matching
            // Clerk attempt has been cleared from the client for
            // any reason (signOut, session timeout, etc.).
        }

        // Fresh attempt — different email OR no last attempt yet.
        // Reset state before trying so a half-completed switch is
        // never observed.
        lastEmailFlow = nil
        lastEmailAddress = nil

        do {
            _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: trimmed)
            lastEmailFlow = .signIn
            lastEmailAddress = trimmed
        } catch {
            // Sign-in failed — if Clerk's message looks like "this
            // identifier isn't registered", fall through to sign-up.
            // Otherwise re-throw so the caller surfaces the real error.
            let raw = error.localizedDescription.lowercased()
            let isNotFound =
                raw.contains("not found")
                || raw.contains("no account")
                || raw.contains("couldn't find")
                || raw.contains("form_identifier_not_found")
                || raw.contains("identifier") && raw.contains("not")
            guard isNotFound else { throw error }

            // Fresh signup. legalAccepted=true is paired with the
            // inline legal disclaimer in SignInSheet (`legalFooter`)
            // that surfaces Terms of Service, Privacy Policy, and
            // Community Guidelines links on both the chooser and
            // email-entry phases. The user implicitly accepts by
            // tapping Send Code after the disclaimer is shown —
            // matches the Sign in with Apple / Google sign-up
            // pattern. Codex P2 #1 on PR #62 flagged the original
            // implementation for setting this flag without an inline
            // disclaimer; the disclaimer addresses that.
            let signUp = try await Clerk.shared.auth.signUp(
                emailAddress: trimmed,
                legalAccepted: true,
            )
            _ = try await signUp.sendEmailCode()
            lastEmailFlow = .signUp
            lastEmailAddress = trimmed
        }
    }

    /// Phase 2: verify the 6-digit code. Dispatches to whichever flow
    /// is in progress (sign-in or sign-up) based on Clerk's client
    /// state, then runs the same post-session plumbing the OAuth
    /// providers use. Throws on bad code, expired attempt, or session
    /// retrieval failure.
    @MainActor
    func verifyEmailCode(_ code: String) async throws {
        guard !isSigningIn else { return }

        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }

        // Dispatch based on `lastEmailFlow` — the flow that was most
        // recently prepared by signInWithEmail(_:) — NOT on whichever
        // attempt happens to be on Clerk's client. The sheet's Back
        // button lets users switch emails between send-code attempts,
        // which can leave BOTH `currentSignIn` and `currentSignUp`
        // populated. Picking the wrong one (e.g. a stale signUp from
        // an aborted typo-corrected flow) makes verification fail
        // even on a valid code. Codex P2 #3 on PR #62 flagged this.
        //
        // After verify(), inspect status. Verifying the email
        // satisfies one requirement, but the Clerk instance may demand
        // more (username, MFA, new password). If status != .complete
        // we'd otherwise call onSessionEstablished(...) which would
        // fail with the generic "no session token" path — leaving the
        // user stuck with no signal. Codex P2 #2 caught this.
        switch lastEmailFlow {
        case .signUp:
            guard let signUp = Clerk.shared.auth.currentSignUp else {
                throw NSError(
                    domain: "PopAlpha.Auth",
                    code: -3,
                    userInfo: [NSLocalizedDescriptionKey: "Sign-up attempt missing. Resend the code."]
                )
            }
            let result = try await signUp.verifyEmailCode(code)
            guard result.status == .complete else {
                throw NSError(
                    domain: "PopAlpha.Auth",
                    code: -4,
                    userInfo: [NSLocalizedDescriptionKey: "Your account needs another step to finish setting up. Please continue on popalpha.ai."]
                )
            }
        case .signIn:
            guard let signIn = Clerk.shared.auth.currentSignIn else {
                throw NSError(
                    domain: "PopAlpha.Auth",
                    code: -3,
                    userInfo: [NSLocalizedDescriptionKey: "Sign-in attempt missing. Resend the code."]
                )
            }
            let result = try await signIn.verifyCode(code)
            guard result.status == .complete else {
                throw NSError(
                    domain: "PopAlpha.Auth",
                    code: -4,
                    userInfo: [NSLocalizedDescriptionKey: "Sign-in needs another step (additional verification). Please continue on popalpha.ai."]
                )
            }
        case nil:
            throw NSError(
                domain: "PopAlpha.Auth",
                code: -3,
                userInfo: [NSLocalizedDescriptionKey: "No sign-in attempt in progress. Resend the code."]
            )
        }

        try await onSessionEstablished(provider: "email")
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
        Logger.auth.debug("restore: user=\(user?.id ?? "nil") session=\(session?.id ?? "nil") clientSessions=\(clientSessions.count)")

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
            Logger.auth.debug("restore: limbo — clearing client (sessions=\(clientSessions.count))")
            do {
                try await Clerk.shared.auth.signOut()
                Logger.auth.debug("signOut(all) ok")
            } catch {
                Logger.auth.debug("signOut(all) failed: \(error)")
            }
            for s in clientSessions {
                do {
                    try await Clerk.shared.auth.signOut(sessionId: s.id)
                    Logger.auth.debug("signOut(sessionId: \(s.id)) ok")
                } catch {
                    Logger.auth.debug("signOut(sessionId: \(s.id)) failed: \(error)")
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
            Logger.auth.debug("401 → minted fresh token, retrying")
            authToken = token
            APIClient.setAuthToken(token)
            return
        }
        Logger.auth.debug("401 → no usable token from Clerk, tearing down")
        isAuthenticated = false
        authToken = nil
        APIClient.setAuthToken(nil)

        // Same cleanup as the cold-launch limbo path. Without this, the
        // user is stuck: local state says signed-out, Clerk says they're
        // still signed in, signIn rejects with session_exists.
        let sessions = Clerk.shared.client?.sessions ?? []
        do {
            try await Clerk.shared.auth.signOut()
            Logger.auth.debug("401 cleanup: signOut(all) ok")
        } catch {
            Logger.auth.debug("401 cleanup: signOut(all) failed: \(error)")
        }
        for s in sessions {
            do {
                try await Clerk.shared.auth.signOut(sessionId: s.id)
                Logger.auth.debug("401 cleanup: signOut(\(s.id)) ok")
            } catch {
                Logger.auth.debug("401 cleanup: signOut(\(s.id)) failed: \(error)")
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
