import Foundation
import OSLog

// MARK: - Notification Service — Background polling for unread count

@Observable
final class NotificationService {
    static let shared = NotificationService()

    private(set) var unreadCount: Int = 0
    private var pollTask: Task<Void, Never>?

    private init() {}

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshUnreadCount()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// One-shot refresh of unread count
    func refreshUnreadCount() async {
        guard AuthService.shared.isAuthenticated else {
            await MainActor.run { self.unreadCount = 0 }
            return
        }

        do {
            let (_, count) = try await ActivityService.shared.fetchNotifications(limit: 1)
            await MainActor.run {
                self.unreadCount = count
            }
        } catch {
            // Best-effort polling (retries every 60s) — don't crash, but
            // log so a persistent failure is visible instead of silent.
            Logger.api.debug("notification unread refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Reset count (e.g. when user views notifications)
    func clearUnreadCount() {
        unreadCount = 0
    }
}
