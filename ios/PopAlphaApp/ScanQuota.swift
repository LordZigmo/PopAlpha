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
    /// Tracks the highest `scansToday` value the warning toast has
    /// already fired for, scoped to the current day. Persisted so the
    /// warning doesn't re-prompt on every cold launch when the user
    /// is sitting at remaining == 1. Reset whenever the day rolls
    /// over (see rolloverIfNewDay).
    private static let warnedScansTodayKey = "ai.popalpha.scan.quota.warned.scansToday"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        rolloverIfNewDay()
    }

    var remaining: Int { max(0, Self.dailyLimit - scansToday) }
    var canScan: Bool { remaining > 0 }

    /// The `scansToday` value the warning was last shown for today,
    /// or nil if the warning hasn't fired yet today. ScannerTabView
    /// uses this for cross-launch dedupe so the toast doesn't re-fire
    /// every time the app re-foregrounds with remaining == 1.
    var lastWarnedScansToday: Int? {
        defaults.object(forKey: Self.warnedScansTodayKey) as? Int
    }

    /// Idempotent rollover. Reads today's local-date key; if it
    /// differs from what's persisted, resets the count AND the
    /// warning dedupe key. Otherwise hydrates `scansToday` from disk
    /// (covers the cold-launch case where the app re-opens after a
    /// quota was set in a prior session on the same calendar day).
    func rolloverIfNewDay() {
        let today = Self.todayKey
        let stored = defaults.string(forKey: Self.dayKey) ?? ""
        if stored != today {
            scansToday = 0
            defaults.set(today, forKey: Self.dayKey)
            defaults.set(0, forKey: Self.countKey)
            // Drop yesterday's warning dedupe — fresh day, the
            // warning is allowed to fire again when the user hits
            // scan #4.
            defaults.removeObject(forKey: Self.warnedScansTodayKey)
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

    /// Refund the most recent recordScan() by decrementing the day's
    /// scan count and re-persisting. Used by multi-scan auto-detect
    /// when a same-card lingering re-fire is dropped post-identify —
    /// the upstream pre-identify gate already charged a quota unit so
    /// the server call could be safely made (and was made — Vision
    /// produced a stable rectangle, runIdentify ran), but the result
    /// was identical to the previously-appended row and never reached
    /// the tray. Without a refund, free-tier users could hit the
    /// paywall while their stack appeared unchanged. Clamped to 0 so
    /// a stray refund without a matching record can't make the
    /// counter negative.
    func refundScan() {
        rolloverIfNewDay()
        guard scansToday > 0 else { return }
        scansToday -= 1
        defaults.set(scansToday, forKey: Self.countKey)
    }

    /// Mark the warning toast as having fired for the current
    /// `scansToday` value. Subsequent calls to `lastWarnedScansToday`
    /// will return this value until the day rolls over.
    func markWarned() {
        rolloverIfNewDay()
        defaults.set(scansToday, forKey: Self.warnedScansTodayKey)
    }

    private static var todayKey: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone.current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: Date())
    }
}
