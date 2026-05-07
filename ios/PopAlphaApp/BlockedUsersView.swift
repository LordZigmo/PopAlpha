import SwiftUI

// MARK: - Blocked Users View
//
// Settings → Privacy → Blocked Users. Apple Guideline 1.2 requires that
// users be able to find and unblock anyone they've blocked. Reachable
// from SettingsView.

struct BlockedUsersView: View {
    @State private var blocks: [BlockedUserEntry] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var unblocking: Set<String> = []

    @StateObject private var blockedStore = BlockedUsersStore.shared

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if isLoading {
                ProgressView().tint(PA.Colors.accent)
            } else if let error {
                errorState(error)
            } else if blocks.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle("Blocked Users")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
        .refreshable { await load() }
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(blocks) { entry in
                    HStack(spacing: 12) {
                        Text(String(entry.displayHandle.prefix(1)).uppercased())
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PA.Colors.text)
                            .frame(width: 32, height: 32)
                            .background(PA.Colors.surfaceSoft)
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 2) {
                            Text("@\(entry.displayHandle)")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(PA.Colors.text)
                            Text("Blocked")
                                .font(PA.Typography.caption)
                                .foregroundStyle(PA.Colors.muted)
                        }

                        Spacer()

                        Button {
                            Task { await unblock(entry) }
                        } label: {
                            if unblocking.contains(entry.blockedId) {
                                ProgressView()
                                    .tint(PA.Colors.accent)
                                    .scaleEffect(0.7)
                                    .frame(minWidth: 64)
                            } else {
                                Text("Unblock")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(PA.Colors.accent)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 6)
                                    .overlay(
                                        Capsule().stroke(PA.Colors.accent.opacity(0.4), lineWidth: 1),
                                    )
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(unblocking.contains(entry.blockedId))
                        .accessibilityLabel("Unblock @\(entry.displayHandle)")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)

                    if entry.id != blocks.last?.id {
                        Divider()
                            .background(PA.Colors.border)
                            .padding(.leading, 60)
                    }
                }
            }
            .padding(.top, 8)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "hand.raised.slash")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("No blocked users")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Anyone you block from a profile, comment, or activity item will appear here.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
    }

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 24))
                .foregroundStyle(PA.Colors.muted)
            Text(msg)
                .font(PA.Typography.cardSubtitle)
                .foregroundStyle(PA.Colors.muted)
            Button("Retry") {
                Task { await load() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.accent)
        }
    }

    private func load() async {
        isLoading = true
        error = nil
        do {
            blocks = try await APIClient.listBlockedUsers()
        } catch {
            self.error = "Couldn't load blocked users."
        }
        isLoading = false
    }

    private func unblock(_ entry: BlockedUserEntry) async {
        unblocking.insert(entry.blockedId)
        defer { unblocking.remove(entry.blockedId) }

        do {
            try await APIClient.unblockUser(entry.blockedId)
            blocks.removeAll { $0.blockedId == entry.blockedId }
            blockedStore.recordUnblock(entry.blockedId)
        } catch {
            // Best-effort: leave the row, user can retry.
        }
    }
}
