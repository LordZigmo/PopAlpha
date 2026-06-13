import SwiftUI

// Continues the static UILaunchScreen (Info.plist → LaunchBackground +
// LaunchLogo) with motion before handing off to ContentView. Background
// color and starting opacity/scale match the static screen so the
// transition from iOS-rendered launch frame to SwiftUI is seamless.
// Self-dismisses by flipping the `isActive` binding after a brief hold
// and exit animation.
//
// Light/dark parity comes from the ASSETS, not this code: both
// LaunchBackground (#F7F7F7 light / #0D1016 dark — light matches the
// homepage PA.Colors.background) and LaunchLogo (black wordmark light /
// white wordmark dark, same 840×182@3x canvas) carry appearance
// variants, and the same two names drive the static frame. RootView
// applies the user's stored AppearanceMode to this view so an in-app
// light/dark override wins over the system scheme here, exactly like
// the homepage.
struct SplashScreenView: View {
    @Binding var isActive: Bool
    @State private var logoScale: CGFloat = 1.0
    @State private var logoOpacity: Double = 1.0

    var body: some View {
        // `.ignoresSafeArea()` on the ZStack itself — not just on the
        // background color — so the logo centers in the FULL screen.
        // The static UILaunchScreen has `UIImageRespectsSafeAreaInsets
        // = false` in Info.plist and so centers in the full screen
        // too; if we only ignore safe area on the background, the
        // ZStack frame stays inset by the safe area and the image
        // ends up centered ~12pt below the static frame on
        // Dynamic-Island devices, producing a visible jolt at the
        // static→SwiftUI handoff.
        ZStack {
            Color("LaunchBackground")

            Image("LaunchLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 280)
                .scaleEffect(logoScale)
                .opacity(logoOpacity)
        }
        .ignoresSafeArea()
        .task {
            withAnimation(.easeInOut(duration: 0.7).repeatCount(2, autoreverses: true)) {
                logoScale = 1.04
            }
            try? await Task.sleep(for: .seconds(2.15))
            withAnimation(.easeInOut(duration: 0.35)) {
                logoOpacity = 0
                logoScale = 1.08
            }
            try? await Task.sleep(for: .milliseconds(350))
            isActive = false
        }
    }
}
