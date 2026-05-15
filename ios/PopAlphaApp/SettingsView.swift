import SwiftUI

// MARK: - Settings View (Apple App Store compliant)

struct SettingsView: View {
    @State private var settings: UserSettings?
    @State private var isLoading = true

    // Local toggle state (synced from server)
    @State private var priceAlerts = true
    @State private var weeklyDigest = true
    @State private var productUpdates = false
    @State private var profileVisibility: ProfileVisibility = .publicVisible
    @State private var activityVisibility: ActivityVisibility = .everyone

    // Bundled-notification delivery time (was previously in NotificationView).
    // DatePicker binds to a Date; we read the hour/minute back out on save
    // and discard the date portion.
    @State private var deliveryTime: Date = SettingsView.defaultDeliveryDate()
    @State private var deliveryTimeLoaded = false
    @State private var isSavingDeliveryTime = false
    @State private var deliveryTimeSaveTask: Task<Void, Never>?

    // Deletion state
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State private var deleteError: String?

    // Export state
    @State private var isExporting = false
    @State private var exportComplete = false

    // Paywall sheet
    @State private var showPaywallSheet = false
    @StateObject private var premiumGate = PremiumGate.shared

    // Appearance — same @AppStorage key as ContentView so the picker
    // here drives the live `.preferredColorScheme(...)` at the root.
    @AppStorage(AppearanceMode.storageKey) private var appearanceRaw: String = AppearanceMode.system.rawValue
    private var appearanceBinding: Binding<AppearanceMode> {
        Binding(
            get: { AppearanceMode(rawValue: appearanceRaw) ?? .system },
            set: { appearanceRaw = $0.rawValue },
        )
    }

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if isLoading {
                ProgressView().tint(PA.Colors.accent)
            } else {
                settingsContent
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await loadSettings()
        }
        .alert("Delete Account?", isPresented: $showDeleteConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Account", role: .destructive) {
                Task { await deleteAccount() }
            }
        } message: {
            Text("This will permanently delete all your data including your portfolio, watchlist, activity, and profile. This action cannot be undone.")
        }
        .alert("Error", isPresented: .init(
            get: { deleteError != nil },
            set: { if !$0 { deleteError = nil } }
        )) {
            Button("OK") { deleteError = nil }
        } message: {
            Text(deleteError ?? "")
        }
        .sheet(isPresented: $showPaywallSheet) {
            PaywallView(surface: "settings_upgrade")
        }
    }

    // MARK: - Subscription row

    @ViewBuilder
    private var subscriptionRow: some View {
        if premiumGate.isPro {
            // Active subscription — link out to App Store for management.
            Link(destination: URL(string: "https://apps.apple.com/account/subscriptions")!) {
                HStack(spacing: 12) {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(PA.Colors.gold)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("PopAlpha Pro")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(PA.Colors.text)
                        Text("Manage your subscription in App Store")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
        } else {
            // Free user — open paywall.
            Button {
                showPaywallSheet = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "crown")
                        .font(.system(size: 16))
                        .foregroundStyle(PA.Colors.accent)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Upgrade to PopAlpha Pro")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(PA.Colors.text)
                        Text("Offline scanner, collector insights, and pro signals")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Content

    private var settingsContent: some View {
        ScrollView {
            VStack(spacing: 24) {
                if !auth.isAuthenticated {
                    // Sign-in prompt inline
                    VStack(spacing: 12) {
                        Image(systemName: "person.crop.circle")
                            .font(.system(size: 36))
                            .foregroundStyle(PA.Colors.accent)
                        Text("Sign in for full settings")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                        Text("Manage notifications, privacy, and your account.")
                            .font(PA.Typography.cardSubtitle)
                            .foregroundStyle(PA.Colors.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 260)
                        Button { AuthService.shared.signIn() } label: {
                            Text("Sign In")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(PA.Colors.accent)
                                .padding(.horizontal, 20).padding(.vertical, 8)
                                .background(PA.Colors.accent.opacity(0.12)).clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 24)
                }

                // Appearance — pure UI preference, no auth required so
                // guest users can flip Light / Dark too. Default
                // `.system` honours the iOS-level Display & Brightness
                // setting; pinning Light or Dark overrides it within
                // PopAlpha. Persisted via @AppStorage so the choice
                // survives app launches; ContentView reads the same key
                // and applies `.preferredColorScheme(...)` at the root.
                settingsSection("Appearance") {
                    pickerRow(
                        icon: "paintbrush",
                        title: "Appearance",
                        selection: appearanceBinding,
                        options: AppearanceMode.allCases
                    ) { /* persisted via @AppStorage; no server sync */ }
                }

                if auth.isAuthenticated {
                // Notifications
                settingsSection("Notifications") {
                    deliveryTimeRow

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    toggleRow(
                        icon: "chart.line.uptrend.xyaxis",
                        title: "Price Alerts",
                        subtitle: "Get notified of significant price changes",
                        isOn: $priceAlerts
                    ) { await save(notifyPriceAlerts: priceAlerts) }

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    toggleRow(
                        icon: "envelope",
                        title: "Weekly Digest",
                        subtitle: "Weekly summary of your collection",
                        isOn: $weeklyDigest
                    ) { await save(notifyWeeklyDigest: weeklyDigest) }

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    toggleRow(
                        icon: "megaphone",
                        title: "Product Updates",
                        subtitle: "New features and announcements",
                        isOn: $productUpdates
                    ) { await save(notifyProductUpdates: productUpdates) }
                }

                // Privacy
                settingsSection("Privacy") {
                    pickerRow(
                        icon: "eye",
                        title: "Profile Visibility",
                        selection: $profileVisibility,
                        options: ProfileVisibility.allCases
                    ) { await save(profileVisibility: profileVisibility.rawValue) }

                    // Activity Visibility + Blocked Users are social-only.
                    // With FeatureFlags.isSocialEnabled off there's no
                    // Feed surface, no follow flow, and no Block UI, so
                    // these rows would gate / list things the user can't
                    // create. Hide them until the discovery surface ships.
                    if FeatureFlags.isSocialEnabled {
                        Divider().background(PA.Colors.border).padding(.leading, 44)

                        pickerRow(
                            icon: "person.2",
                            title: "Activity Visibility",
                            selection: $activityVisibility,
                            options: ActivityVisibility.allCases
                        ) { await save(activityVisibility: activityVisibility.rawValue) }

                        Divider().background(PA.Colors.border).padding(.leading, 44)

                        NavigationLink {
                            BlockedUsersView()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "hand.raised")
                                    .font(.system(size: 16))
                                    .foregroundStyle(PA.Colors.muted)
                                    .frame(width: 28)

                                Text("Blocked Users")
                                    .font(.system(size: 15))
                                    .foregroundStyle(PA.Colors.text)

                                Spacer()

                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(PA.Colors.muted)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Manage blocked users")
                    }
                }

                // Subscription
                settingsSection("Subscription") {
                    subscriptionRow
                }

                // Data & Privacy (Apple compliance)
                settingsSection("Data & Privacy") {
                    // Export data
                    Button {
                        Task { await exportData() }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 16))
                                .foregroundStyle(PA.Colors.accent)
                                .frame(width: 24)

                            VStack(alignment: .leading, spacing: 2) {
                                Text("Export My Data")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(PA.Colors.text)
                                Text("Download all your data as JSON")
                                    .font(PA.Typography.caption)
                                    .foregroundStyle(PA.Colors.muted)
                            }

                            Spacer()

                            if isExporting {
                                ProgressView().tint(PA.Colors.accent).scaleEffect(0.7)
                            } else if exportComplete {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(PA.Colors.positive)
                            } else {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(PA.Colors.muted)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    // Delete account
                    Button {
                        showDeleteConfirmation = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "trash")
                                .font(.system(size: 16))
                                .foregroundStyle(PA.Colors.negative)
                                .frame(width: 24)

                            VStack(alignment: .leading, spacing: 2) {
                                Text("Delete My Account")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(PA.Colors.negative)
                                Text("Permanently remove all your data")
                                    .font(PA.Typography.caption)
                                    .foregroundStyle(PA.Colors.muted)
                            }

                            Spacer()

                            if isDeleting {
                                ProgressView().tint(PA.Colors.negative).scaleEffect(0.7)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)
                    .disabled(isDeleting)
                }

                } // end if auth.isAuthenticated

                // About
                settingsSection("About") {
                    infoRow(icon: "info.circle", title: "Version", value: "1.0.0")

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    linkRow(icon: "doc.text", title: "Terms of Service", url: "https://popalpha.ai/terms")

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    linkRow(icon: "hand.raised", title: "Privacy Policy", url: "https://popalpha.ai/privacy")

                    Divider().background(PA.Colors.border).padding(.leading, 44)

                    linkRow(icon: "person.2", title: "Community Guidelines", url: "https://popalpha.ai/community-guidelines")
                }

                // Sign out (only visible when signed in)
                if auth.isAuthenticated {
                Button {
                    AuthService.shared.signOut()
                    NotificationService.shared.stopPolling()
                } label: {
                    Text("Sign Out")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.negative)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(PA.Colors.negative.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
                }
                .padding(.horizontal, PA.Layout.sectionPadding)
                } // end if auth.isAuthenticated (sign out)
            }
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Section Builder

    private func settingsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
                .padding(.horizontal, PA.Layout.sectionPadding)
                .padding(.bottom, 8)

            VStack(spacing: 0) {
                content()
            }
            .glassSurface(radius: PA.Layout.panelRadius)
            .padding(.horizontal, PA.Layout.sectionPadding)
        }
    }

    // MARK: - Delivery Time Row
    //
    // Compact DatePicker that fits inline with the other notification rows.
    // Wheel-style picker (used in the old NotificationView) is too tall.
    // Debounces saves 500ms so dragging the picker doesn't hammer the API.
    // Captures the IANA timezone on every save so a traveling user has
    // their preference move with them.

    private var deliveryTimeRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "clock")
                .font(.system(size: 16))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("Delivery Time")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                Text("When to get your daily summary")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }

            Spacer()

            if isSavingDeliveryTime {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.mini)
                    .tint(PA.Colors.accent)
            }

            DatePicker(
                "",
                selection: $deliveryTime,
                displayedComponents: .hourAndMinute
            )
            .datePickerStyle(.compact)
            .labelsHidden()
            .tint(PA.Colors.accent)
            .onChange(of: deliveryTime) { _, newValue in
                guard deliveryTimeLoaded else { return }
                scheduleDeliveryTimeSave(newValue)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Daily summary delivery time")
    }

    private func scheduleDeliveryTimeSave(_ newDate: Date) {
        deliveryTimeSaveTask?.cancel()
        deliveryTimeSaveTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await saveDeliveryTime(newDate)
        }
    }

    private func saveDeliveryTime(_ newDate: Date) async {
        let components = Calendar.current.dateComponents([.hour, .minute], from: newDate)
        guard let hour = components.hour, let minute = components.minute else { return }
        let tz = TimeZone.current.identifier
        await MainActor.run { isSavingDeliveryTime = true }
        try? await SettingsService.shared.updateSettings(
            notificationDeliveryHour: hour,
            notificationDeliveryMinute: minute,
            notificationDeliveryTimezone: tz
        )
        await MainActor.run { isSavingDeliveryTime = false }
    }

    /// Build a Date with today's date at the given hour/minute, in the
    /// current calendar. DatePicker binds to Date; the date portion is
    /// irrelevant since we only read hour/minute back on save.
    private static func dateFrom(hour: Int, minute: Int) -> Date {
        var components = DateComponents()
        components.hour = max(0, min(23, hour))
        components.minute = max(0, min(59, minute))
        return Calendar.current.date(from: components) ?? defaultDeliveryDate()
    }

    /// Default value before settings load — 9:00 local.
    private static func defaultDeliveryDate() -> Date {
        var components = DateComponents()
        components.hour = 9
        components.minute = 0
        return Calendar.current.date(from: components) ?? Date()
    }

    // MARK: - Row Builders

    private func toggleRow(icon: String, title: String, subtitle: String, isOn: Binding<Bool>, onChange: @escaping () async -> Void) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                Text(subtitle)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(title). \(subtitle)")

            Spacer()

            Toggle(title, isOn: isOn)
                .tint(PA.Colors.accent)
                .labelsHidden()
                .onChange(of: isOn.wrappedValue) { _, _ in
                    Task { await onChange() }
                }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func pickerRow<T: Hashable & Identifiable & CaseIterable & RawRepresentable>(
        icon: String,
        title: String,
        selection: Binding<T>,
        options: [T],
        onChange: @escaping () async -> Void
    ) -> some View where T.RawValue == String, T: CustomStringConvertible {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(PA.Colors.text)

            Spacer()

            Menu {
                ForEach(options, id: \.id) { option in
                    Button {
                        selection.wrappedValue = option
                        Task { await onChange() }
                    } label: {
                        if selection.wrappedValue.id as? String == option.id as? String {
                            Label(option.description, systemImage: "checkmark")
                        } else {
                            Text(option.description)
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(selection.wrappedValue.description)
                        .font(.system(size: 14))
                        .foregroundStyle(PA.Colors.textSecondary)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10))
                        .foregroundStyle(PA.Colors.muted)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityLabel("\(title): \(selection.wrappedValue.description)")
            .accessibilityHint("Choose \(title.lowercased())")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func infoRow(icon: String, title: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(PA.Colors.text)
            Spacer()
            Text(value)
                .font(.system(size: 14))
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)")
    }

    private func linkRow(icon: String, title: String, url: String) -> some View {
        Link(destination: URL(string: url)!) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.accent)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityHint("Opens link")
    }

    // MARK: - Sign-in Prompt

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "gearshape")
                .font(.system(size: 36)).foregroundStyle(PA.Colors.accent)
            Text("Sign in to access settings")
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(PA.Colors.text)
            Button { AuthService.shared.signIn() } label: {
                Text("Sign In")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 32).padding(.vertical, 12)
                    .background(PA.Colors.accent).clipShape(Capsule())
            }
        }
    }

    // MARK: - Data

    private func loadSettings() async {
        guard auth.isAuthenticated else { isLoading = false; return }
        do {
            let s = try await SettingsService.shared.fetchSettings()
            settings = s
            priceAlerts = s.notifyPriceAlerts
            weeklyDigest = s.notifyWeeklyDigest
            productUpdates = s.notifyProductUpdates
            profileVisibility = ProfileVisibility(rawValue: s.profileVisibility) ?? .publicVisible
            activityVisibility = ActivityVisibility(rawValue: s.activityVisibility) ?? .everyone
            // Set deliveryTime before flipping deliveryTimeLoaded so the
            // hydration assignment doesn't trip the .onChange handler
            // and schedule a no-op save round-trip.
            deliveryTime = Self.dateFrom(
                hour: s.notificationDeliveryHour,
                minute: s.notificationDeliveryMinute
            )
            deliveryTimeLoaded = true
        } catch {
            // Use defaults; still let user interact with the picker.
            deliveryTimeLoaded = true
        }
        isLoading = false
    }

    private func save(
        notifyPriceAlerts: Bool? = nil,
        notifyWeeklyDigest: Bool? = nil,
        notifyProductUpdates: Bool? = nil,
        profileVisibility: String? = nil,
        activityVisibility: String? = nil
    ) async {
        try? await SettingsService.shared.updateSettings(
            notifyPriceAlerts: notifyPriceAlerts,
            notifyWeeklyDigest: notifyWeeklyDigest,
            notifyProductUpdates: notifyProductUpdates,
            profileVisibility: profileVisibility,
            activityVisibility: activityVisibility
        )
    }

    private func deleteAccount() async {
        isDeleting = true
        do {
            try await AccountService.shared.requestAccountDeletion()
            // AuthService.signOut() is called inside requestAccountDeletion
        } catch {
            deleteError = "Failed to delete account: \(error.localizedDescription)"
        }
        isDeleting = false
    }

    private func exportData() async {
        isExporting = true
        exportComplete = false
        do {
            let data = try await AccountService.shared.exportUserData()
            // Save to Documents directory
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            let url = docs.appendingPathComponent("popalpha-export.json")
            try data.write(to: url)
            exportComplete = true
        } catch {
            // Could show error
        }
        isExporting = false
    }
}

// MARK: - CustomStringConvertible conformances

extension ProfileVisibility: CustomStringConvertible {
    var description: String { label }
}

extension ActivityVisibility: CustomStringConvertible {
    var description: String { label }
}
