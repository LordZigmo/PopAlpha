import SwiftUI

// MARK: - Watchlist Toggle Button

struct WatchlistButton: View {
    let slug: String
    let cardName: String
    let setName: String?

    @State private var isWishlisted = false
    @State private var isLoading = false
    @State private var showSignInAlert = false

    var body: some View {
        Button {
            Task { await toggle() }
        } label: {
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
