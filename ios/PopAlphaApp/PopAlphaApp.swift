import SwiftUI

@main
struct PopAlphaApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        configureGlobalAppearance()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        if AuthService.shared.isAuthenticated {
                            NotificationService.shared.startPolling()
                        }
                    case .background:
                        NotificationService.shared.stopPolling()
                    default:
                        break
                    }
                }
        }
    }

    private func configureGlobalAppearance() {
        // Navigation bar
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor(PA.Colors.background)
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor(PA.Colors.text)]
        navAppearance.largeTitleTextAttributes = [.foregroundColor: UIColor(PA.Colors.text)]
        navAppearance.shadowColor = .clear

        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance
        UINavigationBar.appearance().compactAppearance = navAppearance
    }
}
