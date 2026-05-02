import XCTest
@testable import PopAlphaApp

/// Trivial enum verification — quick to write, catches the case where
/// someone adds/renames a ScanLanguage and forgets to update the
/// display labels surfaced in the scanner UI.
final class ScanLanguageTests: XCTestCase {
    func testAllCasesHaveStableRawValues() {
        XCTAssertEqual(ScanLanguage.en.rawValue, "EN")
        XCTAssertEqual(ScanLanguage.jp.rawValue, "JP")
    }

    func testShortLabels() {
        XCTAssertEqual(ScanLanguage.en.shortLabel, "EN")
        XCTAssertEqual(ScanLanguage.jp.shortLabel, "JP")
    }

    func testDisplayNamesAreHumanReadable() {
        XCTAssertEqual(ScanLanguage.en.displayName, "English")
        XCTAssertEqual(ScanLanguage.jp.displayName, "Japanese")
    }

    func testAllCasesIterableHasExpectedCount() {
        // Sentinel: when someone adds a third language, this fails so
        // they remember to also extend the iOS scanner UI + the
        // /api/scan/identify language filter on the server.
        XCTAssertEqual(ScanLanguage.allCases.count, 2)
    }
}
