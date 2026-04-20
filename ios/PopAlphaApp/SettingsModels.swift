import Foundation

// MARK: - Settings Models (matches /api/settings response)

struct UserSettings: Decodable {
    let handle: String?
    let notifyPriceAlerts: Bool
    let notifyWeeklyDigest: Bool
    let notifyProductUpdates: Bool
    /// Preferred hour of day (0–23) for bundled notification delivery,
    /// interpreted in `notificationDeliveryTimezone`.
    let notificationDeliveryHour: Int
    /// Preferred minute (0–59) for bundled notification delivery.
    let notificationDeliveryMinute: Int
    /// IANA timezone name (e.g. "America/New_York"). Defaults to "UTC"
    /// on the server for brand-new rows that haven't been saved yet.
    let notificationDeliveryTimezone: String
    let profileVisibility: String   // "PUBLIC" or "PRIVATE"
    let activityVisibility: String  // "public", "followers", "private"
}

struct SettingsResponse: Decodable {
    let ok: Bool
    let settings: UserSettings
}

// MARK: - Profile Visibility

enum ProfileVisibility: String, CaseIterable, Identifiable {
    case publicVisible = "PUBLIC"
    case privateVisible = "PRIVATE"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .publicVisible: "Public"
        case .privateVisible: "Private"
        }
    }

    var subtitle: String {
        switch self {
        case .publicVisible: "Anyone can see your profile"
        case .privateVisible: "Only you can see your profile"
        }
    }
}

// MARK: - Activity Visibility

enum ActivityVisibility: String, CaseIterable, Identifiable {
    case everyone = "public"
    case followers = "followers"
    case onlyMe = "private"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .everyone: "Everyone"
        case .followers: "Followers"
        case .onlyMe: "Only Me"
        }
    }
}

// MARK: - Data Export

struct DataExportResponse: Decodable {
    let ok: Bool
    let data: ExportData?
}

struct ExportData: Decodable {
    let exportedAt: String
    // All other fields are dynamic JSON — we just store the raw data
}
