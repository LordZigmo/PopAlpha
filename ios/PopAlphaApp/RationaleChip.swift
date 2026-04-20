import SwiftUI

// MARK: - Rationale Chip
//
// Tiny "why this card is on the page" pill. Complements SignalBadgeView
// (HOT / BREAKOUT / WATCH / VALUE) by answering the collector's real
// question — "why is this here for *me*?" — instead of just tagging a
// tier.
//
// Typical labels:
//   • "Matches your style"     (from personalization explanation)
//   • "Watchlist spike"        (card is on the user's watchlist)
//   • "Similar to your cards"  (from personalization)
//   • "Unusual volume"         (section-level override in Market Pulse)
//   • "Thin supply"            (section-level override)
//
// Visual language borrows directly from SignalBadgeView — same capsule,
// same tracking — but muted to textSecondary so the primary badge stays
// the hero when both are present.

struct RationaleChip: View {
    let label: String
    /// When true, render the smaller variant used inside CompactMoverRow.
    var compact: Bool = false
    /// Tint override. Defaults to PA accent; pass a warmer tint for
    /// "Watchlist spike", a cooler tint for "Matches your style", etc.
    var tint: Color = PA.Colors.accent

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "scope")
                .font(.system(size: compact ? 7 : 8, weight: .semibold))
            Text(label)
                .font(.system(size: compact ? 9 : 10, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, compact ? 5 : 7)
        .padding(.vertical, compact ? 2 : 3)
        .background(tint.opacity(0.10))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(tint.opacity(0.22), lineWidth: 0.5)
        )
    }
}

#Preview("Rationale chips") {
    VStack(alignment: .leading, spacing: 8) {
        RationaleChip(label: "Matches your style")
        RationaleChip(label: "Watchlist spike", tint: PA.Colors.gold)
        RationaleChip(label: "Unusual volume", compact: true, tint: PA.Colors.gold)
        RationaleChip(label: "Thin supply", compact: true)
    }
    .padding()
    .background(PA.Colors.background)
    .preferredColorScheme(.dark)
}
