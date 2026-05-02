import Foundation
import OSLog

// MARK: - PopAlphaCore Logger
//
// Module-local Logger.scan extension. Swift extensions don't cross module
// boundaries, so the main app target has its own copy in
// ios/AnalyticsService.swift. Both extensions resolve to the same OS
// log category so Console.app filtering is unified.

extension Logger {
    static let scan = Logger(subsystem: "ai.popalpha.ios", category: "scan")
}
