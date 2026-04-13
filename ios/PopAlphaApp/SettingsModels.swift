import Foundation

// MARK: - Settings Models (matches /api/settings response)

struct UserSettings: Decodable {
    let handle: String?
    let notifyPriceAlerts: Bool
    let notifyWeeklyDigest: Bool
    let notifyProductUpdates: Bool
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
