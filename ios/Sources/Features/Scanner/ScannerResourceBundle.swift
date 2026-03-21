import Foundation

private final class ScannerResourceToken {}

public enum ScannerResourceBundle {
    public static var bundle: Bundle {
        #if SWIFT_PACKAGE
        Bundle.module
        #else
        Bundle(for: ScannerResourceToken.self)
        #endif
    }
}
