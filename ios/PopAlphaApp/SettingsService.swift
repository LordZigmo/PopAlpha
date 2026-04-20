import Foundation

// MARK: - Settings Service — User preferences via PopAlpha API

actor SettingsService {
    static let shared = SettingsService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Fetch current user settings
    func fetchSettings() async throws -> UserSettings {
        try AuthService.shared.requireAuth()

        let response: SettingsResponse = try await APIClient.get(
            path: "/api/settings",
            decoder: decoder
        )
        return response.settings
    }

    /// Update settings (partial — only send changed fields).
    /// Time-related fields should be sent together when the user changes
    /// their delivery time on iOS — the server validates each independently
    /// but sending the IANA timezone alongside keeps stored zones fresh
    /// when the user travels or iOS updates its tz data.
    func updateSettings(
        notifyPriceAlerts: Bool? = nil,
        notifyWeeklyDigest: Bool? = nil,
        notifyProductUpdates: Bool? = nil,
        notificationDeliveryHour: Int? = nil,
        notificationDeliveryMinute: Int? = nil,
        notificationDeliveryTimezone: String? = nil,
        profileVisibility: String? = nil,
        activityVisibility: String? = nil
    ) async throws {
        try AuthService.shared.requireAuth()

        var body: [String: Any] = [:]
        if let v = notifyPriceAlerts { body["notifyPriceAlerts"] = v }
        if let v = notifyWeeklyDigest { body["notifyWeeklyDigest"] = v }
        if let v = notifyProductUpdates { body["notifyProductUpdates"] = v }
        if let v = notificationDeliveryHour { body["notificationDeliveryHour"] = v }
        if let v = notificationDeliveryMinute { body["notificationDeliveryMinute"] = v }
        if let v = notificationDeliveryTimezone { body["notificationDeliveryTimezone"] = v }
        if let v = profileVisibility { body["profileVisibility"] = v }
        if let v = activityVisibility { body["activityVisibility"] = v }

        guard !body.isEmpty else { return }

        let _: SettingsResponse = try await APIClient.patch(
            path: "/api/settings",
            body: body,
            decoder: decoder
        )
    }
}
