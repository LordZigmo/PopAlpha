import SwiftUI

// MARK: - MultiScanTrayBar
//
// The collapsed strip pinned to the bottom of the scanner viewport when
// multi-mode is active. Shows the most-recent thumbnails as horizontal
// chips with the card's name and price stacked below each chip — the
// pack-or-binder use case: "I just slapped a card down, what is it and
// what's it worth?". Tap the whole strip to expand into the review
// sheet.

struct MultiScanTrayBar: View {
    @ObservedObject var session: MultiScanSession
    let onExpand: () -> Void

    private let chipHeight: CGFloat = 64
    private let maxVisibleChips = 4

    var body: some View {
        HStack(spacing: 12) {
            chipsRow
            Spacer(minLength: 0)
            countAndTotal
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.black.opacity(0.55))
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.ultraThinMaterial),
                ),
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5),
        )
        .contentShape(Rectangle())
        .onTapGesture {
            PAHaptics.selection()
            onExpand()
        }
        .padding(.horizontal, 12)
    }

    // MARK: - Subviews

    @ViewBuilder
    private var chipsRow: some View {
        if session.entries.isEmpty {
            // Empty-state guides the user toward the action that populates
            // the tray — without this, a bare bar reads as "is the
            // scanner broken?" because the viewfinder offers no immediate
            // feedback during the first scan attempt.
            HStack(spacing: 8) {
                Image(systemName: "square.stack")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white.opacity(0.6))
                Text("Scan a card to start your stack")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
            }
        } else {
            HStack(spacing: 8) {
                ForEach(visibleChips) { entry in
                    chipColumn(for: entry)
                }
            }
        }
    }

    private var visibleChips: [MultiScanEntry] {
        Array(session.entries.suffix(maxVisibleChips))
    }

    private func chipColumn(for entry: MultiScanEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            AsyncImage(url: URL(string: entry.match.mirroredPrimaryImageUrl ?? "")) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(2.5 / 3.5, contentMode: .fill)
                default:
                    Color.white.opacity(0.06)
                        .overlay(
                            Image(systemName: "rectangle.portrait")
                                .foregroundStyle(.white.opacity(0.3)),
                        )
                }
            }
            .frame(width: chipHeight * (2.5 / 3.5), height: chipHeight)
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .stroke(confidenceColor(entry.confidence), lineWidth: 1.5),
            )

            priceLabel(entry)
        }
    }

    @ViewBuilder
    private func priceLabel(_ entry: MultiScanEntry) -> some View {
        if let price = entry.marketPriceUsd {
            Text(formatPriceCompact(price))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white)
                .monospacedDigit()
                .frame(width: chipHeight * (2.5 / 3.5))
        } else {
            Text("—")
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.5))
                .frame(width: chipHeight * (2.5 / 3.5))
        }
    }

    private var countAndTotal: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("\(session.entries.count)")
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .monospacedDigit()
            if session.totalUsd > 0 {
                Text(formatPrice(session.totalUsd))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .monospacedDigit()
            } else if session.entries.isEmpty {
                EmptyView()
            } else {
                Text("loading…")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
    }

    private func confidenceColor(_ confidence: String) -> Color {
        switch confidence {
        case "high": return Color.green.opacity(0.85)
        case "medium": return Color.yellow.opacity(0.85)
        default: return Color.white.opacity(0.2)
        }
    }

    private func formatPrice(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    /// Compact dollar formatting for the per-chip label — drops the
    /// trailing ".00" on whole dollars so a row of $5 / $12 / $4 / $9
    /// reads cleanly at the chip's narrow width.
    private func formatPriceCompact(_ value: Double) -> String {
        if value >= 100 {
            return String(format: "$%.0f", value)
        }
        if value == value.rounded() {
            return String(format: "$%.0f", value)
        }
        return String(format: "$%.2f", value)
    }
}

// MARK: - MultiScanReviewSheet
//
// Expanded list of tray entries. Per-row swipe-to-delete, manual qty
// stepper, running total, Clear + Add buttons in the footer. Stripped
// down vs the original RFC mock — no per-row re-pick yet, no per-row
// grade picker, no inline error chips. v1 ships the bulk-add core
// flow; richer per-row controls follow once the basic loop is in user
// hands.

struct MultiScanReviewSheet: View {
    @ObservedObject var session: MultiScanSession
    let onDismiss: () -> Void
    /// Returns nil on full success, or a user-facing error string when
    /// submission failed (network, auth, partial-row failure). The
    /// sheet surfaces the string in its footer so a tapped Add button
    /// never feels like a silent no-op — the original v1 always set
    /// `submitting = false` without propagating outcome, which Codex
    /// flagged as a P2 silent-failure case.
    let onSubmit: () async -> String?
    @State private var submitting: Bool = false
    @State private var lastError: String?

    var body: some View {
        NavigationStack {
            Group {
                if session.entries.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done", action: onDismiss)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !session.entries.isEmpty {
                    footer
                }
            }
        }
    }

    // MARK: - Subviews

    private var title: String {
        let n = session.entries.count
        return "Stack — \(n) card\(n == 1 ? "" : "s")"
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.stack")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("Your stack is empty")
                .font(.headline)
            Text("Scanned cards will appear here. Tap Done to keep scanning.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        List {
            ForEach(session.entries) { entry in
                row(for: entry)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
            .onDelete { offsets in
                session.remove(at: offsets)
            }
        }
        .listStyle(.plain)
    }

    private func row(for entry: MultiScanEntry) -> some View {
        HStack(spacing: 12) {
            AsyncImage(url: URL(string: entry.match.mirroredPrimaryImageUrl ?? "")) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().aspectRatio(2.5 / 3.5, contentMode: .fill)
                default:
                    Color.secondary.opacity(0.15)
                }
            }
            .frame(width: 50, height: 70)
            .clipShape(RoundedRectangle(cornerRadius: 4))

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.match.canonicalName)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                Text(setLine(for: entry))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    confidenceBadge(entry.confidence)
                    Spacer(minLength: 0)
                    priceText(entry)
                }
            }

            Stepper(
                value: Binding(
                    get: { entry.quantity },
                    set: { session.updateQuantity(entryId: entry.id, qty: $0) },
                ),
                in: 1...99,
            ) {
                Text("×\(entry.quantity)")
                    .font(.system(size: 14, weight: .medium))
                    .monospacedDigit()
            }
            .labelsHidden()
            .fixedSize()
        }
        .contentShape(Rectangle())
    }

    private func setLine(for entry: MultiScanEntry) -> String {
        let set = entry.match.setName ?? "—"
        let num = entry.match.cardNumber.map { "#\($0)" } ?? ""
        return [set, num].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func confidenceBadge(_ confidence: String) -> some View {
        let (label, color): (String, Color) = {
            switch confidence {
            case "high": return ("HIGH", .green)
            case "medium": return ("MED", .yellow)
            default: return ("?", .secondary)
            }
        }()
        return Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
    }

    @ViewBuilder
    private func priceText(_ entry: MultiScanEntry) -> some View {
        if let price = entry.marketPriceUsd {
            Text(formatPrice(price))
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
        } else {
            Text("—")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        VStack(spacing: 8) {
            if let lastError {
                Text(lastError)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }
            HStack(spacing: 12) {
                Button(role: .destructive) {
                    session.clear()
                } label: {
                    Text("Clear")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                Button {
                    Task {
                        submitting = true
                        lastError = nil
                        let outcome = await onSubmit()
                        submitting = false
                        // nil outcome = full success (sheet closes via
                        // parent on success). Non-nil outcome = HTTP
                        // failure or partial-row failure; surface in
                        // the footer so the user knows the tap did
                        // something (the rows that didn't land are
                        // still in the tray for retry).
                        lastError = outcome
                    }
                } label: {
                    if submitting {
                        ProgressView()
                            .controlSize(.regular)
                            .tint(.white)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        Text("Add \(session.entries.count) to portfolio")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(submitting)
            }
            .padding(.horizontal, 16)
            HStack {
                Text("Total")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(formatPrice(session.totalUsd))
                    .font(.system(size: 14, weight: .semibold))
                    .monospacedDigit()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .background(.bar)
    }

    private func formatPrice(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }
}
