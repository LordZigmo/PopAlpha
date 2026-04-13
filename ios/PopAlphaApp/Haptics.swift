import SwiftUI
import UIKit

// MARK: - Haptics

/// Central haptic feedback helper. Tasteful, low-energy taps used for
/// navigation interactions throughout the app.
enum PAHaptics {
    /// A firm tap for general navigation/button presses.
    static func tap() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred(intensity: 1.0)
    }

    /// A selection change — used when switching between tabs/pills/segments.
    /// Uses a medium impact (instead of the very subtle selection generator)
    /// so it feels satisfying on tab switches.
    static func selection() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred(intensity: 0.9)
    }

    /// A success confirmation — reserved for completed destructive/creative actions.
    static func success() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
    }
}

// MARK: - View helpers

extension View {
    /// Fires a light haptic tap whenever the view is tapped, without
    /// interfering with the underlying tap target (buttons, NavigationLinks,
    /// gestures, etc.).
    func hapticTap() -> some View {
        simultaneousGesture(
            TapGesture().onEnded { PAHaptics.tap() }
        )
    }
}
