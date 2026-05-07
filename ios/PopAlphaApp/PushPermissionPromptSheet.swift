import SwiftUI

// MARK: - Push Permission Prompt Sheet
//
// Apple Guideline 4.5.4: don't ask for system permissions cold. Once a
// user dismisses the system prompt with "Don't Allow", you can never
// show it again from inside the app — they have to open Settings.
//
// This sheet is the soft pre-prompt: shown ONCE after a user signs in,
// it explains the value of push before the system dialog fires. "Enable"
// triggers the real system prompt; "Not Now" defers without burning the
// one-shot. Either way, the sheet is marked seen so we don't pester
// returning users.

struct PushPermissionPromptSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var isRequesting = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Hero
            ZStack {
                Circle()
                    .fill(PA.Colors.accent.opacity(0.15))
                    .frame(width: 96, height: 96)

                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
            }
            .padding(.bottom, 24)

            Text("Stay in the loop")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .multilineTextAlignment(.center)
                .padding(.bottom, 8)

            Text("Get notified when the cards you watch move and when our AI brief drops.")
                .font(.system(size: 15))
                .foregroundStyle(PA.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 28)

            // Benefits
            VStack(alignment: .leading, spacing: 14) {
                benefit(icon: "heart.fill", title: "Wishlist price drops",
                        copy: "Real-time alerts when a card on your wishlist hits a new low.")
                benefit(icon: "chart.line.uptrend.xyaxis", title: "Big movers",
                        copy: "Daily picks for cards that just moved more than the rest of the market.")
                benefit(icon: "sparkles", title: "Daily AI brief",
                        copy: "A short summary of what's happening in the market each morning.")
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 32)

            Spacer()

            // CTAs
            VStack(spacing: 12) {
                Button {
                    Task { await enableTapped() }
                } label: {
                    HStack(spacing: 6) {
                        if isRequesting {
                            ProgressView()
                                .tint(Color.white)
                                .scaleEffect(0.8)
                        }
                        Text("Enable Notifications")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.white)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isRequesting)
                .accessibilityLabel("Enable notifications")

                Button {
                    notNowTapped()
                } label: {
                    Text("Not Now")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.plain)
                .disabled(isRequesting)
                .accessibilityLabel("Not now")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .background(PA.Colors.background.ignoresSafeArea())
        .interactiveDismissDisabled()
    }

    private func benefit(icon: String, title: String, copy: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
                .frame(width: 28, height: 28)
                .background(PA.Colors.accent.opacity(0.12))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                Text(copy)
                    .font(.system(size: 13))
                    .foregroundStyle(PA.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func enableTapped() async {
        isRequesting = true
        defer { isRequesting = false }
        await PushService.shared.requestAuthorizationIfNeeded()
        PushService.shared.markSoftPromptSeen()
        await MainActor.run { dismiss() }
    }

    private func notNowTapped() {
        PushService.shared.markSoftPromptSeen()
        dismiss()
    }
}
