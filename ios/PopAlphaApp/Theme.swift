import SwiftUI
import UIKit

// MARK: - PopAlpha Design System
//
// Every UI surface routes through PA.Colors.* values. The dark palette
// is the original brand identity (near-black surfaces, near-white text);
// the light palette is the trait-aware mirror. Switching is automatic
// via UITraitCollection — no per-view branching required, just stop
// forcing the app into .dark.

private extension Color {
    /// Returns a color that resolves against the current trait collection
    /// at render time, so it auto-flips when the user switches between
    /// light and dark mode (Settings → Display & Brightness, or system
    /// schedule). All adaptive PA.Colors entries are built from this.
    init(light: Color, dark: Color) {
        self = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(dark)
                : UIColor(light)
        })
    }
}

enum PA {

    // MARK: Colors
    enum Colors {
        // Backgrounds
        static let background = Color(
            light: Color(red: 0.969, green: 0.969, blue: 0.969),    // #F7F7F7
            dark:  Color(red: 0.039, green: 0.039, blue: 0.039)     // #0A0A0A
        )
        static let surface = Color(
            light: Color(red: 1.000, green: 1.000, blue: 1.000),    // #FFFFFF
            dark:  Color(red: 0.067, green: 0.067, blue: 0.067)     // #111111
        )
        static let surfaceSoft = Color(
            light: Color(red: 0.941, green: 0.941, blue: 0.941),    // #F0F0F0
            dark:  Color(red: 0.102, green: 0.102, blue: 0.102)     // #1A1A1A
        )
        static let surfaceHover = Color(
            light: Color(red: 0.898, green: 0.898, blue: 0.898),    // #E5E5E5
            dark:  Color(red: 0.133, green: 0.133, blue: 0.133)     // #222222
        )

        // Brand accent — cyan reads on both white and black, so single value.
        static let accent = Color(red: 0.0, green: 0.706, blue: 0.847)              // #00B4D8
        static let accentSoft = Color(red: 0.0, green: 0.706, blue: 0.847).opacity(0.15)

        // Text
        static let text = Color(
            light: Color(red: 0.039, green: 0.039, blue: 0.039),    // #0A0A0A
            dark:  Color(red: 0.941, green: 0.941, blue: 0.941)     // #F0F0F0
        )
        static let textSecondary = Color(
            light: Color(red: 0.420, green: 0.420, blue: 0.420),    // #6B6B6B
            dark:  Color(red: 0.580, green: 0.580, blue: 0.580)     // #949494
        )
        static let muted = Color(
            light: Color(red: 0.580, green: 0.580, blue: 0.580),    // #949494
            dark:  Color(red: 0.420, green: 0.420, blue: 0.420)     // #6B6B6B
        )

        // Borders
        static let border = Color(
            light: Color(red: 0.898, green: 0.898, blue: 0.898),    // #E5E5E5
            dark:  Color(red: 0.118, green: 0.118, blue: 0.118)     // #1E1E1E
        )
        static let borderLight = Color(
            light: Color.black.opacity(0.06),
            dark:  Color.white.opacity(0.06)
        )

        // Semantic indicators — same in both modes (universal red/green/gold).
        static let positive = Color(red: 0.0, green: 0.863, blue: 0.353)            // #00DC5A
        static let negative = Color(red: 1.0, green: 0.231, blue: 0.188)            // #FF3B30
        static let neutral = Color(red: 0.612, green: 0.639, blue: 0.686)           // #9CA3AF
        static let gold = Color(red: 1.0, green: 0.843, blue: 0.0)                  // #FFD700

        // Subtle overlay (adaptive)
        static let shimmer = Color(
            light: Color.black.opacity(0.04),
            dark:  Color.white.opacity(0.04)
        )

        /// Adaptive hairline / glass-overlay color.
        ///
        /// The all-dark era used `Color.white.opacity(N)` everywhere for
        /// hairlines, separators, and glass surfaces. On a white light-mode
        /// background those overlays vanish. This helper returns the
        /// equivalent black-opacity value in light mode so subtle UI
        /// stays visible without losing the dark-mode aesthetic.
        ///
        /// Use anywhere you'd otherwise write `Color.white.opacity(N)`.
        static func hairline(_ opacity: Double) -> Color {
            Color(
                light: Color.black.opacity(opacity),
                dark:  Color.white.opacity(opacity)
            )
        }
    }

    // MARK: Collector Axis Palette
    // One color per radar axis. Badges adopt the color of the axis they
    // express, so a Grail Hunter chip is the same red-orange as Market
    // Heat, a Vintage Loyalist is the same amber as Nostalgia, etc.
    // Japanese Specialist gets its own color since it's no longer a
    // radar axis — it's a modifier badge with its own identity.
    enum AxisColors {
        static let nostalgia       = Color(red: 0.961, green: 0.651, blue: 0.137)   // #F5A623 warm amber
        static let currentEra      = Color(red: 0.039, green: 0.518, blue: 1.0)     // #0A84FF iOS blue
        static let slabFocus       = Color(red: 0.612, green: 0.639, blue: 0.686)   // #9CA3AF cool silver
        static let marketHeat      = Color(red: 0.937, green: 0.267, blue: 0.267)   // #EF4444 hot red
        static let tasteProfile    = Color(red: 0.659, green: 0.333, blue: 0.969)   // #A855F7 royal purple
        static let collectionDepth = Color(red: 0.133, green: 0.773, blue: 0.369)   // #22C55E forest green
        static let japanese        = Color(red: 0.925, green: 0.282, blue: 0.600)   // #EC4899 sakura pink
    }

    // MARK: Gradients
    enum Gradients {
        static let cardSurface = LinearGradient(
            colors: [
                Colors.surface,
                Color(
                    light: Color(red: 0.953, green: 0.953, blue: 0.961),    // off-white
                    dark:  Color(red: 0.055, green: 0.055, blue: 0.063)
                )
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        static let cardBorder = LinearGradient(
            colors: [
                Color(
                    light: Color.black.opacity(0.08),
                    dark:  Color.white.opacity(0.08)
                ),
                Color(
                    light: Color.black.opacity(0.02),
                    dark:  Color.white.opacity(0.02)
                )
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        static let accentGlow = RadialGradient(
            colors: [Colors.accent.opacity(0.15), .clear],
            center: .center,
            startRadius: 0,
            endRadius: 120
        )

        static let heroOverlay = LinearGradient(
            colors: [.clear, Colors.background.opacity(0.9)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: Typography
    enum Typography {
        static let heroPrice = Font.system(size: 34, weight: .bold, design: .rounded)
        static let cardPrice = Font.system(size: 18, weight: .bold, design: .rounded)
        static let cardTitle = Font.system(size: 14, weight: .semibold)
        static let cardSubtitle = Font.system(size: 12, weight: .medium)
        static let sectionTitle = Font.system(size: 20, weight: .bold)
        static let badge = Font.system(size: 11, weight: .semibold)
        static let caption = Font.system(size: 11, weight: .medium)
        static let tabLabel = Font.system(size: 10, weight: .medium)
    }

    // MARK: Spacing & Radii
    enum Layout {
        static let cardRadius: CGFloat = 16
        static let panelRadius: CGFloat = 20
        static let pillRadius: CGFloat = 10
        static let gridSpacing: CGFloat = 12
        static let sectionPadding: CGFloat = 20
        static let cardPadding: CGFloat = 12
    }
}

// MARK: - Appearance Mode
//
// User-selectable override for the system color scheme. Defaults to
// `.system` so the app honours iOS Settings → Display & Brightness;
// `.light` / `.dark` let users pin a specific mode in PopAlpha
// regardless of the system setting (useful for collectors who want a
// dark hobby app on a light-mode phone, or vice versa). Persisted
// via `@AppStorage("popalpha.appearance.v1")` and applied at the root
// via `.preferredColorScheme(appearance.colorScheme)`.

enum AppearanceMode: String, CaseIterable, Identifiable, CustomStringConvertible {
    case system, light, dark

    /// UserDefaults key. Reusing for any future opt-in appearance
    /// migrations would bump the suffix.
    static let storageKey = "popalpha.appearance.v1"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System Default"
        case .light:  "Light"
        case .dark:   "Dark"
        }
    }

    var description: String { label }

    /// Maps to SwiftUI's `.preferredColorScheme(_:)` argument.
    /// `nil` = inherit system; an explicit value pins the app to that
    /// scheme regardless of the global setting.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light:  .light
        case .dark:   .dark
        }
    }
}

// MARK: - Reusable Modifiers

struct GlassSurface: ViewModifier {
    var radius: CGFloat = PA.Layout.cardRadius

    func body(content: Content) -> some View {
        content
            .background(PA.Gradients.cardSurface)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(PA.Gradients.cardBorder, lineWidth: 1)
            )
    }
}

struct PremiumShadow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .shadow(color: .black.opacity(0.4), radius: 16, x: 0, y: 8)
            .shadow(color: .black.opacity(0.2), radius: 4, x: 0, y: 2)
    }
}

extension View {
    func glassSurface(radius: CGFloat = PA.Layout.cardRadius) -> some View {
        modifier(GlassSurface(radius: radius))
    }

    func premiumShadow() -> some View {
        modifier(PremiumShadow())
    }
}
