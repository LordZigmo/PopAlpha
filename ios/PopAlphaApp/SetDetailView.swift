import SwiftUI
import NukeUI

// MARK: - Set Browser
//
// Displays all cards in a given set sorted by price (desc), with card
// images, name, number, and current RAW price. Tapping a card pushes
// the card detail view. Mirrors the web `/sets/[setName]` page.

struct SetDetailView: View {
    let setName: String

    @Environment(\.dismiss) private var dismiss
    @State private var cards: [MarketCard] = []
    @State private var loading = true
    @State private var selectedCard: MarketCard?

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 16) {
                header

                if loading {
                    loadingState
                } else if cards.isEmpty {
                    emptyState
                } else {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(cards) { card in
                            Button {
                                PAHaptics.tap()
                                selectedCard = card
                            } label: {
                                SetCardCell(card: card)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(PA.Colors.background)
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    PAHaptics.tap()
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial.opacity(0.5))
                        .clipShape(Circle())
                }
            }
        }
        .navigationDestination(item: $selectedCard) { card in
            CardDetailView(card: card)
        }
        // .task(id:) instead of plain .task so the load only fires when
        // setName actually changes (i.e. navigating TO a new set) — NOT
        // on every view re-appear. Without this, popping back from
        // CardDetailView re-runs the task, flips `loading = true` for a
        // frame, body re-renders the loading branch, the grid gets
        // destroyed, and scroll resets to the top. The fix is app-wide:
        // see WatchlistView, PortfolioView, NotificationView, etc.
        .task(id: setName) { await loadSetCards() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(setName)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(PA.Colors.text)

            if !loading {
                Text("\(cards.count) card\(cards.count == 1 ? "" : "s")")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .padding(.top, 4)
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 60)
            ProgressView()
                .tint(PA.Colors.accent)
            Text("Loading set...")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer().frame(height: 60)
            Image(systemName: "rectangle.stack")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)
            Text("No cards found for this set")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Data Loading

    private func loadSetCards() async {
        loading = true
        do {
            cards = try await CardService.shared.fetchSetCards(setName: setName)
        } catch {
            print("[SetDetailView] Failed to load set: \(error)")
            cards = []
        }
        loading = false
    }
}

// MARK: - Set Card Cell

private struct SetCardCell: View {
    let card: MarketCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Card image
            ZStack {
                if let url = card.imageURL {
                    LazyImage(url: url) { state in
                        if let image = state.image {
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } else if state.error != nil {
                            placeholder
                        } else {
                            placeholder
                                .overlay(ProgressView().tint(PA.Colors.muted))
                        }
                    }
                } else {
                    placeholder
                }
            }
            .aspectRatio(63.0 / 88.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(PA.Colors.border, lineWidth: 1)
            )

            // Name + number
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                Text(card.cardNumber.isEmpty ? "—" : card.cardNumber)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }

            // Price + change
            if card.price > 0 {
                HStack(spacing: 4) {
                    Text(card.formattedPrice)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(PA.Colors.accent)

                    if card.changePct != 0 {
                        Text(card.changeText)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(card.isPositive ? PA.Colors.positive : PA.Colors.negative)
                    }
                }
            } else {
                Text("—")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    private var placeholder: some View {
        Rectangle()
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 20))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            )
    }
}

#Preview("Set Detail") {
    NavigationStack {
        SetDetailView(setName: "Prismatic Evolutions")
    }
    .preferredColorScheme(.dark)
}
