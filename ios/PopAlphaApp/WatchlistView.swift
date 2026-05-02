import SwiftUI
import NukeUI

// MARK: - Watchlist View

struct WatchlistView: View {
    @State private var items: [WishlistService.WishlistItem] = []
    @State private var isLoading = true
    @State private var error: String?

    private var auth: AuthService { AuthService.shared }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            if isLoading && items.isEmpty {
                loadingState
            } else if let error, items.isEmpty {
                errorState(error)
            } else if items.isEmpty {
                emptyState
            } else {
                watchlistContent
            }
        }
        .navigationTitle("Watchlist")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        // .task(id:) prevents the auto-reload-on-re-appear that was
        // swapping the loading state in and out and resetting scroll
        // to the top when users popped back from a card detail view.
        // Load runs once per session and re-runs only when auth state
        // flips (sign-in / sign-out). Pull-to-refresh still covers
        // explicit refreshes.
        .task(id: auth.isAuthenticated) {
            await loadWatchlist()
        }
        .refreshable {
            await loadWatchlist()
        }
    }

    // MARK: - Content

    private var watchlistContent: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(items) { item in
                    watchlistRow(item)
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
    }

    private func watchlistRow(_ item: WishlistService.WishlistItem) -> some View {
        HStack(spacing: 12) {
            // Thumbnail
            if let url = item.imageURL {
                LazyImage(url: url) { state in
                    if let img = state.image {
                        img.resizable().aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        thumbnailPlaceholder
                    }
                }
                .frame(width: 48, height: 67)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                thumbnailPlaceholder.frame(width: 48, height: 67)
            }

            // Info
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                if let set = item.setName {
                    Text(set)
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                        .lineLimit(1)
                }

                if let note = item.note, !note.isEmpty {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(PA.Colors.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer()

            // Remove button
            Button {
                Task { await removeItem(slug: item.canonicalSlug) }
            } label: {
                Image(systemName: "heart.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.negative)
            }
            .accessibilityLabel("Remove from watchlist")
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            )
    }

    // MARK: - States

    private var signInPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "heart")
                .font(.system(size: 36)).foregroundStyle(PA.Colors.accent)
            Text("Sign in to use your watchlist")
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(PA.Colors.text)
            Text("Save cards you want to track and get notified when prices change.")
                .font(PA.Typography.cardSubtitle).foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center).frame(maxWidth: 280)
            Button { AuthService.shared.signIn() } label: {
                Text("Sign In")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .padding(.horizontal, 32).padding(.vertical, 12)
                    .background(PA.Colors.accent).clipShape(Capsule())
            }
        }
    }

    private var loadingState: some View {
        VStack { Spacer(); ProgressView().tint(PA.Colors.accent); Spacer() }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle").font(.system(size: 28)).foregroundStyle(PA.Colors.muted)
            Text(message).font(PA.Typography.cardSubtitle).foregroundStyle(PA.Colors.muted)
            Button("Retry") { Task { await loadWatchlist() } }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(PA.Colors.accent)
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "heart").font(.system(size: 32)).foregroundStyle(PA.Colors.muted)
            Text("No cards wishlisted").font(.system(size: 18, weight: .semibold)).foregroundStyle(PA.Colors.text)
            Text(auth.isAuthenticated
                 ? "Heart cards from the market to add them here."
                 : "Sign in to save cards and get notified when prices change.")
                .font(PA.Typography.cardSubtitle).foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center).frame(maxWidth: 260)

            if !auth.isAuthenticated {
                Button { AuthService.shared.signIn() } label: {
                    Text("Sign In")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                        .padding(.horizontal, 20).padding(.vertical, 8)
                        .background(PA.Colors.accent.opacity(0.12)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
            Spacer()
        }
    }

    // MARK: - Data

    private func loadWatchlist() async {
        guard auth.isAuthenticated else {
            isLoading = false
            return
        }
        isLoading = items.isEmpty
        error = nil
        do {
            items = try await WishlistService.shared.fetchWishlist()
        } catch {
            self.error = "Couldn't load watchlist"
        }
        isLoading = false
    }

    private func removeItem(slug: String) async {
        // Optimistic removal
        let removed = items.first(where: { $0.canonicalSlug == slug })
        items.removeAll(where: { $0.canonicalSlug == slug })

        do {
            _ = try await WishlistService.shared.removeItem(slug: slug)
        } catch {
            // Revert
            if let removed { items.append(removed) }
        }
    }
}
