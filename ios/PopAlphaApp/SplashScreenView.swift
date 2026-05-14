import SwiftUI

// Continues the static UILaunchScreen (Info.plist → LaunchBackground +
// LaunchLogo) with motion before handing off to ContentView. Background
// color and starting opacity/scale match the static screen so the
// transition from iOS-rendered launch frame to SwiftUI is seamless.
// Self-dismisses by flipping the `isActive` binding after a brief hold
// and exit animation.
struct SplashScreenView: View {
    @Binding var isActive: Bool
    @State private var logoScale: CGFloat = 1.0
    @State private var logoOpacity: Double = 1.0

    var body: some View {
        ZStack {
            Color("LaunchBackground")
                .ignoresSafeArea()

            Image("ModernWhiteLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 280)
                .scaleEffect(logoScale)
                .opacity(logoOpacity)
        }
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
