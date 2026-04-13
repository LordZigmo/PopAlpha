import SwiftUI

// MARK: - Notification View

struct NotificationView: View {
    @State private var notifications: [ActivityService.NotificationItem] = []
    @State private var isLoading = true
    @State private var error: String?

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if isLoading && notifications.isEmpty {
                loadingState
            } else if let error, notifications.isEmpty {
                errorState(error)
            } else if notifications.isEmpty {
                emptyState
            } else {
                notificationList
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await loadNotifications()
        }
        .refreshable {
            await loadNotifications()
        }
    }

    // MARK: - List

    private var notificationList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(notifications) { notification in
                    notificationRow(notification)

                    if notification.id != notifications.last?.id {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.leading, 56)
                    }
                }
            }
            .padding(.top, 8)
        }
    }

    private func notificationRow(_ notification: ActivityService.NotificationItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            // Unread dot
            ZStack {
                Text(notification.actor.avatarInitial)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .frame(width: 36, height: 36)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(Circle())

                if !notification.read {
                    Circle()
                        .fill(PA.Colors.accent)
                        .frame(width: 8, height: 8)
                        .offset(x: 14, y: -14)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(notification.text)
                    .font(.system(size: 14))
                    .foregroundStyle(notification.read ? PA.Colors.textSecondary : PA.Colors.text)
                    .lineLimit(2)

                Text(timeAgo(notification.createdAt))
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }

            Spacer()

            // Type icon
            notificationIcon(notification.type)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(notification.read ? Color.clear : PA.Colors.accent.opacity(0.04))
    }

    private func notificationIcon(_ type: String) -> some View {
        Group {
            switch type {
            case "like":
                Image(systemName: "heart.fill")
                    .foregroundStyle(PA.Colors.negative)
            case "comment":
                Image(systemName: "bubble.right.fill")
                    .foregroundStyle(PA.Colors.accent)
            case "follow":
                Image(systemName: "person.badge.plus")
                    .foregroundStyle(PA.Colors.positive)
            default:
                Image(systemName: "bell.fill")
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .font(.system(size: 14))
    }

    // MARK: - States

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "bell.badge")
                .font(.system(size: 36))
                .foregroundStyle(PA.Colors.accent)

            Text("Sign in for notifications")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text("Get notified when collectors interact with your activity.")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)

            Button {
                AuthService.shared.signIn()
            } label: {
                Text("Sign In")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
            }
        }
    }

    private var loadingState: some View {
        VStack {
            Spacer()
            ProgressView()
                .tint(PA.Colors.accent)
            Spacer()
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text(message)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Retry") {
                Task { await loadNotifications() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "bell.slash")
                .font(.system(size: 32))
                .foregroundStyle(PA.Colors.muted)

            Text("No notifications")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text(auth.isAuthenticated
                 ? "When collectors like, comment, or follow you, you'll see it here."
                 : "Sign in to get notified when collectors interact with you.")
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)

            if !auth.isAuthenticated {
                Button { AuthService.shared.signIn() } label: {
                    Text("Sign In")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 20).padding(.vertical, 8)
                        .background(PA.Colors.accent.opacity(0.12)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
            Spacer()
        }
    }

    // MARK: - Data

    private func loadNotifications() async {
        guard auth.isAuthenticated else {
            isLoading = false
            return
        }
        isLoading = notifications.isEmpty
        error = nil
        do {
            let (items, _) = try await ActivityService.shared.fetchNotifications()
            notifications = items

            // Mark as read
            try? await ActivityService.shared.markNotificationsRead()
            NotificationService.shared.clearUnreadCount()
        } catch {
            self.error = "Couldn't load notifications"
        }
        isLoading = false
    }

    // MARK: - Helpers

    private func timeAgo(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        return "\(days)d"
    }
}
