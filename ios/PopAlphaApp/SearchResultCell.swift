import SwiftUI
import NukeUI

// MARK: - Search Result Cell

struct SearchResultCell: View {
    let card: SearchCardResult

    var body: some View {
        HStack(spacing: 12) {
            // Card thumbnail
            if let url = card.imageURL {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else if state.error != nil {
                        thumbnailPlaceholder
                    } else {
                        thumbnailPlaceholder
                            .overlay(
                                ProgressView()
                                    .tint(PA.Colors.muted)
                                    .scaleEffect(0.6)
                            )
                    }
                }
                .frame(width: 48, height: 67)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                thumbnailPlaceholder
                    .frame(width: 48, height: 67)
            }

            // Card info
            VStack(alignment: .leading, spacing: 4) {
                Text(card.canonicalName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    if let setName = card.setName {
                        Text(setName)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                            .lineLimit(1)
                    }

                    if let number = card.displayNumber {
                        Text("·")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.border)

                        Text(number)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }

                if let year = card.year {
                    Text(String(year))
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted.opacity(0.6))
                }
            }

            Spacer()

            // Chevron
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.muted.opacity(0.5))
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            )
    }
}

// MARK: - Compact Suggestion Cell (for autocomplete dropdown)

struct SearchSuggestionCell: View {
    let card: SearchCardResult

    var body: some View {
        HStack(spacing: 10) {
            // Small thumbnail
            if let url = card.imageURL {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        smallPlaceholder
                    }
                }
                .frame(width: 32, height: 45)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            } else {
                smallPlaceholder
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(card.canonicalName)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                HStack(spacing: 4) {
                    if let setName = card.setName {
                        Text(setName)
                            .lineLimit(1)
                    }
                    if let number = card.displayNumber {
                        Text("·")
                        Text(number)
                            .fontDesign(.monospaced)
                    }
                }
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.muted)
            }

            Spacer()
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
    }

    private var smallPlaceholder: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(PA.Colors.surfaceSoft)
            .frame(width: 32, height: 45)
    }
}
