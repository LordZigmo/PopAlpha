import SwiftUI

// MARK: - PopAlpha Design System

enum PA {

    // MARK: Colors
    enum Colors {
        static let background = Color(red: 0.039, green: 0.039, blue: 0.039)       // #0A0A0A
        static let surface = Color(red: 0.067, green: 0.067, blue: 0.067)           // #111111
        static let surfaceSoft = Color(red: 0.102, green: 0.102, blue: 0.102)       // #1A1A1A
        static let surfaceHover = Color(red: 0.133, green: 0.133, blue: 0.133)      // #222222
        static let accent = Color(red: 0.0, green: 0.706, blue: 0.847)              // #00B4D8
        static let accentSoft = Color(red: 0.0, green: 0.706, blue: 0.847).opacity(0.15)
        static let text = Color(red: 0.941, green: 0.941, blue: 0.941)              // #F0F0F0
        static let textSecondary = Color(red: 0.580, green: 0.580, blue: 0.580)     // #949494
        static let muted = Color(red: 0.420, green: 0.420, blue: 0.420)             // #6B6B6B
        static let border = Color(red: 0.118, green: 0.118, blue: 0.118)            // #1E1E1E
        static let borderLight = Color.white.opacity(0.06)
        static let positive = Color(red: 0.0, green: 0.863, blue: 0.353)            // #00DC5A
        static let negative = Color(red: 1.0, green: 0.231, blue: 0.188)            // #FF3B30
        static let gold = Color(red: 1.0, green: 0.843, blue: 0.0)                  // #FFD700
        static let shimmer = Color.white.opacity(0.04)
    }

    // MARK: Gradients
    enum Gradients {
        static let cardSurface = LinearGradient(
            colors: [
                Colors.surface,
                Color(red: 0.055, green: 0.055, blue: 0.063)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        static let cardBorder = LinearGradient(
            colors: [
                Color.white.opacity(0.08),
                Color.white.opacity(0.02)
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
