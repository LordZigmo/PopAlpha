// ScanQuota.swift
//
// Free-tier daily scan limiter. Pro users bypass entirely — the
// caller (ScannerTabView) short-circuits the quota check on
// PremiumGate.isPro before incrementing or reading remaining.
//
// Storage: UserDefaults. Stores (today's local-date key, count).
// On rollover (local-time date change), the count resets to 0.
//
// Bypass surface: deleting + reinstalling the app resets defaults,
// so a determined free user can reset their quota daily by reinstalling.
// Acceptable for v1 — moving the count server-side is a follow-up
// once we see real abuse signal. Most users won't bother.
//
// Time zone: uses TimeZone.current. A user who travels across the
// dateline at midnight could in theory game the system; not worth
// the complexity to defend against today.

import Combine
import Foundation

@MainActor
final class ScanQuota: ObservableObject {
    static let shared = ScanQuota()

    /// Free-tier daily scan cap.
    static let dailyLimit: Int = 5

    @Published private(set) var scansToday: Int = 0

    private static let countKey = "ai.popalpha.scan.quota.count"
    private static let dayKey = "ai.popalpha.scan.quota.day"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        rolloverIfNewDay()
    }

    var remaining: Int { max(0, Self.dailyLimit - scansToday) }
    var canScan: Bool { remaining > 0 }

    /// Idempotent rollover. Reads today's local-date key; if it
    /// differs from what's persisted, resets the count. Otherwise
    /// hydrates `scansToday` from disk (covers the cold-launch case
    /// where the app re-opens after a quota was set in a prior
    /// session on the same calendar day).
    func rolloverIfNewDay() {
        let today = Self.todayKey
        let stored = defaults.string(forKey: Self.dayKey) ?? ""
        if stored != today {
            scansToday = 0
            defaults.set(today, forKey: Self.dayKey)
            defaults.set(0, forKey: Self.countKey)
        } else {
            scansToday = defaults.integer(forKey: Self.countKey)
        }
    }

    /// Increment the day's scan count by 1 and persist.
    func recordScan() {
        rolloverIfNewDay()
        scansToday += 1
        defaults.set(scansToday, forKey: Self.countKey)
    }

    private static var todayKey: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone.current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: Date())
    }
}
