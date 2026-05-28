import SwiftUI
import OSLog

// MARK: - Notification View
//
// Profile → Activity. Activity feed (likes / comments / follows).
//
// Delivery-time preferences and notification toggles live in
// SettingsView → Notifications. This view is the activity stream only.

struct NotificationView: View {
    @State private var notifications: [ActivityService.NotificationItem] = []
    @State private var isLoadingFeed = true
    @State private var feedError: String?

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if !auth.isAuthenticated {
                signInPrompt
            } else {
                authedContent
            }
        }
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        // .task(id:) so we only fetch when auth state flips, not on
        // every view re-appear. Avoids resetting the scroll position of
        // the activity feed every time the user pops back to this
        // screen. Manual refresh still works.
        .task(id: auth.isAuthenticated) {
            await loadFeed()
        }
        .refreshable {
            await loadFeed()
        }
    }

    // MARK: - Authenticated layout

    private var authedContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                activityFeedHeader
                    .padding(.horizontal, PA.Layout.sectionPadding)
                    .padding(.top, 12)

                feedBody
            }
            .padding(.bottom, 24)
        }
    }

    private var activityFeedHeader: some View {
        Text("ACTIVITY")
            .font(.system(size: 10, weight: .semibold))
            .tracking(2.0)
            .foregroundStyle(PA.Colors.muted)
    }

    // MARK: - Feed section

    @ViewBuilder
    private var feedBody: some View {
        if isLoadingFeed && notifications.isEmpty {
            feedInline(
                icon: nil,
                text: "Loading activity…",
                showProgress: true
            )
        } else if let feedError, notifications.isEmpty {
            VStack(spacing: 8) {
                feedInline(
                    icon: "exclamationmark.triangle",
                    text: feedError,
                    showProgress: false
                )
                Button("Retry") { Task { await loadFeed() } }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }
        } else if notifications.isEmpty {
            feedInline(
                icon: "bell.slash",
                text: "When collectors like, comment, or follow you, you'll see it here.",
                showProgress: false
            )
        } else {
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
        }
    }

    private func feedInline(icon: String?, text: String, showProgress: Bool) -> some View {
        VStack(spacing: 10) {
            if showProgress {
                ProgressView().tint(PA.Colors.accent)
            } else if let icon {
                Image(systemName: icon)
                    .font(.system(size: 28))
                    .foregroundStyle(PA.Colors.muted)
            }
            Text(text)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Individual activity row (unchanged from the pre-rewrite version)

    private func notificationRow(_ notification: ActivityService.NotificationItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
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
            // Avatar initial + unread dot are visual-only; the text below
            // already says who and what.
            .accessibilityHidden(true)

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

            notificationIcon(notification.type)
                // Decorative — type is conveyed by notification.text.
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(notification.read ? Color.clear : PA.Colors.accent.opacity(0.04))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(notification.read ? "" : "Unread. ")\(notification.text). \(timeAgo(notification.createdAt))")
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

    // MARK: - Signed-out state

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "bell.badge")
                .font(.system(size: 36))
                .foregroundStyle(PA.Colors.accent)

            Text("Sign in for activity")
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

    // MARK: - Data

    private func loadFeed() async {
        guard auth.isAuthenticated else {
            isLoadingFeed = false
            return
        }
        isLoadingFeed = notifications.isEmpty
        feedError = nil
        do {
            let (items, _) = try await ActivityService.shared.fetchNotifications()
            notifications = items
            do {
                try await ActivityService.shared.markNotificationsRead()
            } catch {
                Logger.api.debug("markNotificationsRead failed: \(error.localizedDescription, privacy: .public)")
            }
            NotificationService.shared.clearUnreadCount()
        } catch {
            feedError = "Couldn't load activity"
        }
        isLoadingFeed = false
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
