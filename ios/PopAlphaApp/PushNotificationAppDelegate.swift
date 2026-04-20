import UIKit
import UserNotifications

// MARK: - Push Notification App Delegate
//
// SwiftUI's @main PopAlphaApp has no UIApplicationDelegate by default,
// but APNs registration callbacks still fire through the classic
// UIKit delegate hooks. We bridge via @UIApplicationDelegateAdaptor in
// PopAlphaApp.swift so we get:
//
//   • didRegisterForRemoteNotificationsWithDeviceToken — success
//   • didFailToRegisterForRemoteNotifications         — failure
//   • didReceiveRemoteNotification (silent pushes)    — background refresh
//
// All heavy lifting is delegated to PushService so this file stays tiny
// and testable.

final class PushNotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set ourselves as the notification-center delegate so we get
        // foreground-presentation + tap callbacks. The actual permission
        // prompt and registerForRemoteNotifications() call are deferred
        // to PushService.requestAuthorizationIfNeeded(), typically after
        // sign-in rather than cold launch — better opt-in rates.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - APNs token callbacks

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hexToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await PushService.shared.handleRegisteredToken(hexToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushService.shared.handleRegistrationFailure(error)
    }

    // MARK: - Silent (content-available) push

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // Silent pushes: refresh unread notification count so the bell
        // badge updates without needing the user to open the app.
        Task {
            await NotificationService.shared.refreshUnreadCount()
            completionHandler(.newData)
        }
    }

    // MARK: - Foreground + tap delegates

    /// Present banner/list/sound even when the app is already open so
    /// collectors don't miss price-move / activity alerts mid-session.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list, .badge])
    }

    /// User tapped a push — bump unread count immediately and hand off
    /// deep-link handling to PushService (which parses userInfo for
    /// `deepLink` / `notification_id`).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        PushService.shared.handleNotificationTap(response.notification.request.content.userInfo)
        Task { await NotificationService.shared.refreshUnreadCount() }
        completionHandler()
    }
}
