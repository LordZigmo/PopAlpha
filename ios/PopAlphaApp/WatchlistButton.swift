import SwiftUI

// MARK: - Watchlist Toggle Button

struct WatchlistButton: View {
    let slug: String
    let cardName: String
    let setName: String?
    /// When true, renders as a small icon-only circle (suitable for
    /// stacking above the bottom-right FAB on a detail view) instead
    /// of the default labeled capsule.
    var compact: Bool = false

    @State private var isWishlisted = false
    @State private var isLoading = false
    @State private var showSignInAlert = false

    var body: some View {
        Button {
            Task { await toggle() }
        } label: {
            if compact {
                compactLabel
            } else {
                labeledLabel
            }
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .task {
            isWishlisted = await WishlistService.shared.isWishlisted(slug: slug)
        }
        .alert("Sign in required", isPresented: $showSignInAlert) {
            Button("Sign In") { AuthService.shared.signIn() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Sign in to add cards to your wishlist.")
        }
        .accessibilityLabel(isWishlisted ? "Remove from wishlist" : "Add to wishlist")
    }

    // MARK: - Variants

    /// Labeled capsule used inline in lists / action rows.
    private var labeledLabel: some View {
        HStack(spacing: 5) {
            if isLoading {
                ProgressView()
                    .tint(isWishlisted ? PA.Colors.negative : PA.Colors.muted)
                    .scaleEffect(0.6)
            } else {
                Image(systemName: isWishlisted ? "heart.fill" : "heart")
                    .font(.system(size: 13))
                    .foregroundStyle(isWishlisted ? PA.Colors.negative : PA.Colors.muted)
            }
            Text(isWishlisted ? "Wishlisted" : "Wishlist")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isWishlisted ? PA.Colors.negative : PA.Colors.muted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isWishlisted ? PA.Colors.negative.opacity(0.1) : PA.Colors.surfaceSoft)
        .clipShape(Capsule())
    }

    /// Compact 44pt icon-only circle used as a secondary FAB. Sits on
    /// a frosted-glass background so it reads as secondary to the
    /// accent-filled primary "+" FAB without disappearing into the
    /// content beneath it.
    private var compactLabel: some View {
        Group {
            if isLoading {
                ProgressView()
                    .tint(isWishlisted ? PA.Colors.negative : PA.Colors.text)
                    .scaleEffect(0.7)
            } else {
                Image(systemName: isWishlisted ? "heart.fill" : "heart")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(isWishlisted ? PA.Colors.negative : PA.Colors.text)
            }
        }
        .frame(width: 44, height: 44)
        .background(.ultraThinMaterial)
        .clipShape(Circle())
        .overlay(
            Circle()
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.25), radius: 6, x: 0, y: 2)
    }

    private func toggle() async {
        guard AuthService.shared.isAuthenticated else {
            showSignInAlert = true
            return
        }

        let wasWishlisted = isWishlisted
        isWishlisted.toggle() // Optimistic
        isLoading = true

        do {
            if wasWishlisted {
                _ = try await WishlistService.shared.removeItem(slug: slug)
            } else {
                _ = try await WishlistService.shared.addItem(slug: slug)
            }
        } catch {
            isWishlisted = wasWishlisted // Revert
        }

        isLoading = false
    }
}
