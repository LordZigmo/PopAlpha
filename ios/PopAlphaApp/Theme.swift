import SwiftUI
import UIKit

// MARK: - PopAlpha Design System
//
// Every UI surface routes through PA.Colors.* values. The dark palette
// is the original brand identity (near-black surfaces, near-white text);
// the light palette is the trait-aware mirror. Switching is automatic
// via UITraitCollection — no per-view branching required, just stop
// forcing the app into .dark.

extension Color {
    /// Returns a color that resolves against the current trait collection
    /// at render time, so it auto-flips when the user switches between
    /// light and dark mode (Settings → Display & Brightness, or system
    /// schedule). All adaptive PA.Colors entries are built from this;
    /// internal (not private) so component-local accent palettes — e.g.
    /// Collector Insight's purples — can adapt the same way.
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

// MARK: - Market
//
// User-selectable view of the homepage: English-language catalog (the
// historical PopAlpha view, branded blue) or Japanese-language catalog
// (the JP wedge, branded Hinomaru red). Stored per-device via
// `@AppStorage("popalpha.market.v1")`; injected onto the homepage
// NavigationStack via the `\.market` environment value so only the
// homepage subtree reflows in red — settings, card detail, paywall, and
// every other view that doesn't opt into the environment keep the
// canonical brand blue (`PA.Colors.accent`).

enum Market: String, CaseIterable, Identifiable, CustomStringConvertible {
    case en, jp

    static let storageKey = "popalpha.market.v1"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .en: "EN"
        case .jp: "JP"
        }
    }

    /// Spoken by VoiceOver for the toggle segments.
    var accessibilityLabel: String {
        switch self {
        case .en: "English market"
        case .jp: "Japanese market"
        }
    }

    var description: String { label }

    /// Brand-identity accent. `.en` returns the historical PopAlpha blue
    /// so existing call sites that opt into `\.market` render identically
    /// in EN mode. `.jp` returns Hinomaru red.
    var accent: Color {
        switch self {
        case .en: PA.Colors.accent
        case .jp: Color(red: 0.737, green: 0.0, blue: 0.176) // #BC002D
        }
    }

    var accentSoft: Color {
        accent.opacity(0.15)
    }
}

private struct MarketEnvironmentKey: EnvironmentKey {
    static let defaultValue: Market = .en
}

extension EnvironmentValues {
    /// Current homepage market. Default `.en`; injected onto the
    /// MarketplaceView NavigationStack so only homepage subviews that
    /// declare `@Environment(\.market)` reflow in the JP brand color.
    var market: Market {
        get { self[MarketEnvironmentKey.self] }
        set { self[MarketEnvironmentKey.self] = newValue }
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

// MARK: - Liquid Glass Surface
//
// Multi-layered material card used for the homepage AI surfaces
// (MarketHeroCard, AIBriefCard). Composes four passes:
//
//   1. `.regularMaterial` — actual frosted-glass refraction of the
//      underlying background.
//   2. Accent `LinearGradient` wash across the entire container — a
//      diagonal flow of the brand color (no single solid tint, no
//      corner-pinned radial bloom).
//   3. Scroll-driven specular highlight — a soft white band whose
//      position along the diagonal tracks the card's global Y. As
//      the user scrolls, the shine sweeps the card like light moving
//      across glass.
//   4. Gradient stroke rim — accent + white in a diagonal blend so the
//      edge reads as a lit bevel rather than a flat hairline.
//
// Plus dual shadows: a colored glow (lift) and a dark drop (depth).
// Deliberately no left accent rail — the gradient + rim carries the
// brand identity, and the card reads as a single glass plane.
struct LiquidGlassSurface: ViewModifier {
    var accent: Color
    var radius: CGFloat = PA.Layout.panelRadius
    /// Peak opacity of the scroll-driven specular highlight (0..1).
    /// The highlight uses the accent color (not white) so it reads
    /// as a tinted reflection of the card itself — a brighter glint
    /// of the same chroma. With this peak paired against `halfWidth`
    /// (in `shineStops`) the highlight feels like a slow gentle wash
    /// rather than a defined corner hotspot.
    var shineIntensity: Double = 0.08

    /// The accent wash is dialed back in light mode so that small
    /// accent-colored labels (eg. `MarketHeroCard`'s "POPALPHA"
    /// eyebrow, `AIBriefCard`'s timestamp) keep WCAG-readable contrast
    /// against the tinted glass. In dark mode the rich stops can run
    /// hot because the foreground text is light and the material
    /// renders dark anyway.
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .background {
                GeometryReader { proxy in
                    let progress = shineProgress(proxy.frame(in: .global).minY)
                    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                    ZStack {
                        // `.ultraThinMaterial` preserves more of the
                        // colored wash below than `.regularMaterial` —
                        // less neutral-gray frost, more chroma.
                        shape.fill(.ultraThinMaterial)
                        // Accent gradient runs much hotter than the
                        // PR #84 originals so the surface reads as a
                        // rich tinted glass rather than a desaturated
                        // wash. The shimmer now competes against a
                        // richer chromatic base, so it stands out less.
                        // Light-mode stops are roughly half the dark
                        // values to preserve text contrast — see the
                        // `colorScheme` doc note above.
                        shape.fill(
                            LinearGradient(
                                colors: accentGradientColors,
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        shape.fill(
                            LinearGradient(
                                stops: shineStops(progress: progress),
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .blendMode(.plusLighter)
                    }
                    .allowsHitTesting(false)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: borderGradientColors,
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            }
            // Light mode gets no chroma halo — the accent glow around
            // every card was the single biggest "blue" signal on the
            // light homepage. Dark keeps the tinted bloom.
            .shadow(
                color: colorScheme == .light ? .black.opacity(0.06) : accent.opacity(0.30),
                radius: 18, x: 0, y: 6
            )
            .shadow(
                color: .black.opacity(colorScheme == .light ? 0.10 : 0.20),
                radius: 24, x: 0, y: 12
            )
    }

    /// Border stops. Light mode is a neutral glass edge (faint dark
    /// hairline + white sheen); dark keeps the accent-tinted rim.
    private var borderGradientColors: [Color] {
        if colorScheme == .light {
            return [
                .black.opacity(0.10),
                .white.opacity(0.45),
                .black.opacity(0.06),
                .white.opacity(0.30)
            ]
        }
        return [
            accent.opacity(0.50),
            .white.opacity(0.16),
            accent.opacity(0.18),
            .white.opacity(0.22)
        ]
    }

    /// Accent-wash stops. Dark mode runs hot (rich tinted glass);
    /// light mode runs cool to preserve small-text contrast.
    private var accentGradientColors: [Color] {
        switch colorScheme {
        case .light:
            // 2026-06-11 (round 2): chroma-free. Even the "whisper"
            // accent stops (0.10/0.04/0.08/0.03) still read as a blue
            // wash across the homepage in light mode — owner asked for
            // the blue gone completely. Light glass is now pure neutral
            // frost: white sheen over the material, zero accent in the
            // wash (accent survives only in small text/icons, which sit
            // on the content layer, not the surface). Dark is untouched.
            return [
                .white.opacity(0.45),
                .white.opacity(0.18),
                .white.opacity(0.32),
                .white.opacity(0.12)
            ]
        case .dark:
            // The original PR #86 values (0.55 / 0.22 / 0.45 / 0.18)
            // formed a wave with two bright stops, the first sitting at
            // `topLeading` — so every card showed a fixed bright cyan
            // hotspot in the upper-left corner that no shimmer tweak
            // could mask. These flatter, monotonic-ish stops keep the
            // rich tinted-glass feel while smoothing out the two peaks.
            return [
                accent.opacity(0.38),
                accent.opacity(0.30),
                accent.opacity(0.32),
                accent.opacity(0.22)
            ]
        @unknown default:
            return [
                accent.opacity(0.40),
                accent.opacity(0.16),
                accent.opacity(0.32),
                accent.opacity(0.12)
            ]
        }
    }

    /// Maps the card's global vertical position to a 0..1 progress used
    /// to slide the specular highlight diagonally. minY large positive
    /// (card below viewport) → 0; minY zero or negative (card at/above
    /// viewport top) → 1. Viewport height is approximated rather than
    /// read from the scene because the value is only used to pace the
    /// shine, not to register events.
    private func shineProgress(_ minY: CGFloat) -> Double {
        let viewportH: CGFloat = 850
        let raw = 1.0 - Double(minY / viewportH)
        return min(max(raw, 0), 1)
    }

    private func shineStops(progress: Double) -> [Gradient.Stop] {
        let center = max(0, min(1, progress))
        // Wider band → the highlight diffuses across the card instead
        // of forming a defined hotspot. Combined with the lower peak
        // intensity this reads as a slow wash, not a lit corner.
        let halfWidth = 0.28
        // Accent-colored shimmer (not white) so the sweep reads as a
        // tinted reflection of the card's own color rather than a
        // bright white streak. With `.plusLighter` blending against
        // the accent-tinted base below, the highlight area looks like
        // a brighter glint of the same chroma — exactly how a real
        // reflection on tinted glass behaves.
        // In light mode the sweep is pure white — a specular glint on
        // neutral glass. Even a low-peak accent-colored band read as a
        // moving blue shimmer (round 1 cut it to a third; round 2
        // removes the chroma entirely per owner feedback). Dark keeps
        // the tinted reflection.
        let sweep: Color = colorScheme == .light ? .white : accent
        let peak = colorScheme == .light ? shineIntensity * 0.5 : shineIntensity
        return [
            .init(color: sweep.opacity(0), location: max(center - halfWidth, 0)),
            .init(color: sweep.opacity(peak), location: center),
            .init(color: sweep.opacity(0), location: min(center + halfWidth, 1))
        ]
    }
}

extension View {
    func glassSurface(radius: CGFloat = PA.Layout.cardRadius) -> some View {
        modifier(GlassSurface(radius: radius))
    }

    func premiumShadow() -> some View {
        modifier(PremiumShadow())
    }

    func liquidGlassSurface(
        accent: Color,
        radius: CGFloat = PA.Layout.panelRadius,
        shineIntensity: Double = 0.08
    ) -> some View {
        modifier(LiquidGlassSurface(accent: accent, radius: radius, shineIntensity: shineIntensity))
    }
}
