import SwiftUI
import NukeUI
import OSLog

// MARK: - Set Browser
//
// Displays all cards in a given set sorted by price (desc), with card
// images, name, number, and current RAW price. Tapping a card pushes
// the card detail view. Mirrors the web `/sets/[setName]` page.

struct SetDetailView: View {
    let setName: String

    @Environment(\.dismiss) private var dismiss
    @State private var cards: [MarketCard] = []
    @State private var metadata: SetMetadataRow?
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

            // Era + release date subtitle (when known). Populated by the
            // scrydex_set_metadata backfill — see scripts/backfill-sets-
            // era-release-date.mjs. ~99% of sets have at least one field.
            if !loading, let metadata, hasEraOrReleaseDate(metadata) {
                HStack(spacing: 6) {
                    if let era = metadata.era, !era.isEmpty {
                        Text(era)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.text)
                    }
                    if metadata.era != nil, !(metadata.era?.isEmpty ?? true),
                       let formattedDate = formatReleaseDate(metadata.releaseDate) {
                        Text("·")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                        Text(formattedDate)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    } else if let formattedDate = formatReleaseDate(metadata.releaseDate) {
                        Text(formattedDate)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }

            if !loading {
                Text("\(cards.count) card\(cards.count == 1 ? "" : "s")")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
        }
        .padding(.top, 4)
    }

    private func hasEraOrReleaseDate(_ metadata: SetMetadataRow) -> Bool {
        let hasEra = !(metadata.era?.isEmpty ?? true)
        let hasDate = !(metadata.releaseDate?.isEmpty ?? true)
        return hasEra || hasDate
    }

    /// Format a "YYYY-MM-DD" date string as "MMM d, yyyy" (e.g. "Jan 20, 2023").
    /// Returns nil if the input is missing or unparseable.
    private func formatReleaseDate(_ iso: String?) -> String? {
        guard let iso, !iso.isEmpty else { return nil }
        let input = DateFormatter()
        input.dateFormat = "yyyy-MM-dd"
        input.timeZone = TimeZone(identifier: "UTC")
        guard let date = input.date(from: iso) else { return nil }
        let output = DateFormatter()
        output.dateFormat = "MMM d, yyyy"
        return output.string(from: date)
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
        // Cards and metadata in parallel — both kick off here. We await
        // cards first and flip `loading` off the moment the grid can
        // render, so a slow/hanging metadata fetch can't keep the user
        // staring at a spinner. Metadata is informational only — it
        // populates the header subtitle when it eventually returns.
        async let cardsTask = CardService.shared.fetchSetCards(setName: setName)
        async let metadataTask = CardService.shared.fetchSetMetadata(setName: setName)

        do {
            cards = try await cardsTask
        } catch {
            Logger.ui.debug("Failed to load set cards: \(error)")
            cards = []
        }
        loading = false

        // Metadata after — failure is non-blocking and never gates render.
        // If setName changes mid-fetch, structured concurrency cancels
        // this await along with the rest of the .task(id:) handler.
        do {
            metadata = try await metadataTask
        } catch {
            Logger.ui.debug("Failed to load set metadata: \(error)")
            metadata = nil
        }
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

                    Text(card.changeText)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(card.direction.color)
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
}
