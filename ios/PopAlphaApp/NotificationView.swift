import SwiftUI

// MARK: - Notification View
//
// Profile → Notifications. Split into two stacked sections:
//
//   1. Delivery-time preferences (wheel-style DatePicker)
//   2. Activity feed (likes / comments / follows)
//
// The preferences section is the first thing a collector sees when
// they open Notifications, so they can discover and set their
// preferred delivery time without hunting in Settings. The feed
// scrolls below it.

struct NotificationView: View {
    @State private var notifications: [ActivityService.NotificationItem] = []
    @State private var isLoadingFeed = true
    @State private var feedError: String?

    // Delivery-time preferences — loaded separately from the feed so
    // the picker can be interactive even if the feed fails to load.
    @State private var settings: UserSettings?
    @State private var selectedDeliveryTime: Date = defaultDeliveryDate()
    @State private var deliveryTimezone: String = TimeZone.current.identifier
    @State private var isSavingTime = false
    @State private var saveTask: Task<Void, Never>?

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
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await loadAll()
        }
        .refreshable {
            await loadAll()
        }
    }

    // MARK: - Authenticated layout

    private var authedContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                deliveryTimeSection
                    .padding(.horizontal, PA.Layout.sectionPadding)
                    .padding(.top, 12)

                activityFeedHeader
                    .padding(.horizontal, PA.Layout.sectionPadding)
                    .padding(.top, 4)

                feedBody
            }
            .padding(.bottom, 24)
        }
    }

    // MARK: - Delivery time section
    //
    // Wheel-style DatePicker scoped to hour + minute. Debounces writes
    // 500ms after the user stops spinning so we don't hammer the server
    // on every tick. The IANA timezone is captured on every save so a
    // user who travels will have their server-side preference move
    // with them.

    private var deliveryTimeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("DELIVERY TIME")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(PA.Colors.accent)
                if isSavingTime {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .controlSize(.mini)
                        .tint(PA.Colors.accent)
                }
                Spacer()
            }

            Text("When to get your daily summary")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(PA.Colors.text)

            Text("Price moves, alerts, and activity are bundled into one push near this time so your phone stays quiet the rest of the day.")
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.textSecondary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            // Wheel-style picker. `.labelsHidden()` hides the empty
            // leading label so the wheel centers itself.
            DatePicker(
                "",
                selection: $selectedDeliveryTime,
                displayedComponents: .hourAndMinute
            )
            .datePickerStyle(.wheel)
            .labelsHidden()
            .tint(PA.Colors.accent)
            .colorScheme(.dark)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .onChange(of: selectedDeliveryTime) { _, newValue in
                scheduleSave(newValue)
            }

            HStack(spacing: 4) {
                Image(systemName: "globe")
                    .font(.system(size: 10, weight: .medium))
                Text("Using \(TimeZone.current.identifier)")
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(PA.Colors.muted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(radius: PA.Layout.cardRadius)
    }

    private var activityFeedHeader: some View {
        Text("ACTIVITY")
            .font(.system(size: 10, weight: .semibold))
            .tracking(2.0)
            .foregroundStyle(PA.Colors.muted)
    }

    // MARK: - Feed section (replaces the full-screen states with inline
    // variants so the delivery-time picker stays visible above them).

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

    // MARK: - Signed-out state

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "bell.badge")
                .font(.system(size: 36))
                .foregroundStyle(PA.Colors.accent)

            Text("Sign in for notifications")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text("Set your delivery time and get notified when collectors interact with your activity.")
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

    private func loadAll() async {
        async let settingsTask: Void = loadSettings()
        async let feedTask: Void = loadFeed()
        _ = await (settingsTask, feedTask)
    }

    private func loadSettings() async {
        guard auth.isAuthenticated else { return }
        do {
            let fetched = try await SettingsService.shared.fetchSettings()
            await MainActor.run {
                settings = fetched
                selectedDeliveryTime = dateFrom(
                    hour: fetched.notificationDeliveryHour,
                    minute: fetched.notificationDeliveryMinute
                )
                deliveryTimezone = fetched.notificationDeliveryTimezone
            }
        } catch {
            // Non-fatal — leave the picker at the default 9am value so
            // the user can still interact. Next save will still succeed.
            print("[NotificationView] settings load failed: \(error)")
        }
    }

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
            try? await ActivityService.shared.markNotificationsRead()
            NotificationService.shared.clearUnreadCount()
        } catch {
            feedError = "Couldn't load activity"
        }
        isLoadingFeed = false
    }

    // MARK: - Save debounce
    //
    // DatePicker.onChange fires on every tick as the wheel spins. We
    // wait 500ms after the last change before actually hitting the
    // server. Each new change cancels the pending save.

    private func scheduleSave(_ newDate: Date) {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await saveDeliveryTime(newDate)
        }
    }

    private func saveDeliveryTime(_ newDate: Date) async {
        let components = Calendar.current.dateComponents([.hour, .minute], from: newDate)
        guard let hour = components.hour, let minute = components.minute else { return }

        let tz = TimeZone.current.identifier
        await MainActor.run { isSavingTime = true }
        do {
            try await SettingsService.shared.updateSettings(
                notificationDeliveryHour: hour,
                notificationDeliveryMinute: minute,
                notificationDeliveryTimezone: tz
            )
            await MainActor.run {
                deliveryTimezone = tz
                isSavingTime = false
            }
        } catch {
            print("[NotificationView] save delivery time failed: \(error)")
            await MainActor.run { isSavingTime = false }
        }
    }

    // MARK: - Helpers

    /// Produce a Date value "today at HH:MM local" from the stored
    /// hour/minute integers. DatePicker binds to a Date, not to raw
    /// components — the date portion is irrelevant since we only read
    /// hour/minute back out.
    private func dateFrom(hour: Int, minute: Int) -> Date {
        var components = DateComponents()
        components.hour = max(0, min(23, hour))
        components.minute = max(0, min(59, minute))
        return Calendar.current.date(from: components) ?? Self.defaultDeliveryDate()
    }

    /// Default value when settings haven't loaded yet — 9:00 local.
    private static func defaultDeliveryDate() -> Date {
        var components = DateComponents()
        components.hour = 9
        components.minute = 0
        return Calendar.current.date(from: components) ?? Date()
    }

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
