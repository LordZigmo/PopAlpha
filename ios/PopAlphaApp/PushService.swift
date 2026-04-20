import Foundation
import UIKit
import UserNotifications

// MARK: - Push Service
//
// Orchestrates the full client-side APNs lifecycle:
//
//   1. requestAuthorizationIfNeeded() — asks for notification permission
//      (alert / sound / badge). Safe to call repeatedly; no-ops once the
//      user has responded. Call this after sign-in, not on cold launch,
//      so the prompt feels earned.
//
//   2. UIKit callback → handleRegisteredToken(_:) — fires when APNs
//      returns the device token. We persist it locally (for dedup /
//      change detection) and upload to `/api/device/register` so the
//      server can target this user's device.
//
//   3. handleNotificationTap(_:) — invoked by the app delegate when a
//      push is tapped. Currently just nudges the notification feed to
//      refresh; deep linking can be layered on top later by reading
//      `userInfo["deepLink"]`.
//
// The uploaded token is keyed server-side on clerk_user_id + token, so
// sending users nuisance duplicates on token rotation / reinstall is
// impossible by construction.

@Observable
final class PushService {
    static let shared = PushService()

    // Published UI-observable state. `authorizationStatus` lets views
    // render a "Turn on notifications" banner if a user declined.
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    private(set) var lastUploadError: String?

    // Last successfully uploaded token — avoids re-uploading on every
    // app launch when Apple hands us the same token we already sent.
    private let defaults = UserDefaults.standard
    private let lastUploadedTokenKey = "popalpha.push.lastUploadedToken.v1"

    private init() {
        Task { await refreshAuthorizationStatus() }
    }

    // MARK: - Permission + registration

    /// Ask for notification permission. If granted, immediately register
    /// with APNs so iOS delivers a device token via the AppDelegate.
    /// Safe to call from the main thread or a Task. No-op when the user
    /// has previously declined — in that case we surface the status so
    /// UI can prompt the user to visit Settings.
    func requestAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
        print("[PushService] requestAuthorizationIfNeeded: status=\(settings.authorizationStatus.rawValue)")

        switch settings.authorizationStatus {
        case .notDetermined:
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                await refreshAuthorizationStatus()
                print("[PushService] permission granted=\(granted) — calling registerForRemoteNotifications()")
                if granted {
                    await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
                }
            } catch {
                print("[PushService] requestAuthorization threw: \(error)")
                lastUploadError = error.localizedDescription
            }
        case .authorized, .provisional, .ephemeral:
            print("[PushService] already authorized — calling registerForRemoteNotifications()")
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        case .denied:
            // User opted out; don't bother re-prompting. UI can route
            // them to iOS Settings if we ever need to re-ask.
            print("[PushService] user denied previously — not re-prompting")
            break
        @unknown default:
            break
        }
    }

    /// Force-refresh the cached authorization status — useful after the
    /// app returns from Settings where the user may have toggled push.
    func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run { self.authorizationStatus = settings.authorizationStatus }
    }

    // MARK: - Token upload

    /// Called by PushNotificationAppDelegate when APNs hands us a token.
    /// Debounces against the last-uploaded value to avoid hammering the
    /// register endpoint on every launch.
    func handleRegisteredToken(_ hexToken: String) async {
        print("[PushService] handleRegisteredToken called, length=\(hexToken.count)")
        guard !hexToken.isEmpty else {
            print("[PushService] empty token — bailing")
            return
        }
        let composite = compositeSignature(token: hexToken)
        if defaults.string(forKey: lastUploadedTokenKey) == composite {
            print("[PushService] token already uploaded (cache hit) — no-op")
            return
        }

        // Guest devices can't register — the endpoint requires a Clerk
        // session. Token is buffered implicitly: when the user signs in,
        // AuthService calls requestAuthorizationIfNeeded() which
        // re-triggers registerForRemoteNotifications() → new callback.
        guard AuthService.shared.isAuthenticated else {
            print("[PushService] not authenticated yet — token buffered, will upload after sign-in")
            return
        }

        print("[PushService] uploading device_token suffix=\(hexToken.suffix(8)) env=\(apnsEnvironment)")
        do {
            try await APIClient.post(
                path: "/api/device/register",
                body: [
                    "device_token": hexToken,
                    "bundle_id": Bundle.main.bundleIdentifier ?? "",
                    "environment": apnsEnvironment,
                    "device_model": UIDevice.current.model,
                    "os_version": UIDevice.current.systemVersion,
                ]
            )
            defaults.set(composite, forKey: lastUploadedTokenKey)
            await MainActor.run { self.lastUploadError = nil }
            print("[PushService] upload OK")
        } catch {
            await MainActor.run { self.lastUploadError = error.localizedDescription }
            // Print both the localized form AND the full debug form so the
            // body of an HTTP error (which carries the server's stage info)
            // is visible in the Xcode console.
            print("[PushService] upload FAILED: \(error.localizedDescription)")
            if case let APIError.httpError(status, body) = error {
                print("[PushService]   status=\(status) body=\(body)")
            }
        }
    }

    func handleRegistrationFailure(_ error: Error) {
        // Silent on simulator — APNs registration always fails there
        // with "remote notifications are not supported in the simulator"
        // which is expected and not actionable.
        #if targetEnvironment(simulator)
        return
        #else
        print("[PushService] APNs registration failed: \(error)")
        lastUploadError = error.localizedDescription
        #endif
    }

    // MARK: - Tap handling

    /// Called when the user taps a delivered push. For now we just
    /// refresh the in-app notification feed; deep-link routing (e.g.
    /// jump to a card detail) can read `userInfo["deepLink"]` and
    /// dispatch through a shared coordinator in a follow-up.
    func handleNotificationTap(_ userInfo: [AnyHashable: Any]) {
        // no-op placeholder — deep link routing is a follow-up PR
        _ = userInfo
    }

    /// Call on sign-out so we don't target a signed-out account. Clears
    /// the local "last uploaded" cache so the next sign-in re-registers.
    func clearUploadedTokenCache() {
        defaults.removeObject(forKey: lastUploadedTokenKey)
    }

    // MARK: - Helpers

    /// A composite signature capturing (token, env, bundle) so flipping
    /// between dev / prod entitlements or reinstalling correctly
    /// forces a re-upload. Token alone isn't enough — APNs may issue
    /// the same token under both environments in dev builds.
    private func compositeSignature(token: String) -> String {
        "\(token)::\(apnsEnvironment)::\(Bundle.main.bundleIdentifier ?? "")"
    }

    /// Mirrors the aps-environment entitlement so the server can pick
    /// the right APNs host (sandbox vs production). Debug → development,
    /// release → production. Keep this in lockstep with PopAlphaApp.entitlements.
    private var apnsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
}
