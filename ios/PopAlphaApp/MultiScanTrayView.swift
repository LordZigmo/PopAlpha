import SwiftUI

// MARK: - MultiScanFlashCard
//
// Transient overlay shown immediately after a multi-scan auto-append.
// The matched card's primary image pops into the lower-middle of the
// viewport with the market price floating in front of it. The price
// fades after ~1s; the card itself fades shortly after. Tapping the
// overlay (any time it's visible) opens the review sheet so the user
// can view + bulk-add their stack.
//
// Replaces the earlier bottom tray-bar UX (2026-05-16 redesign): the
// per-card flash is more "scan and forget" — match Eyevo's pattern —
// and reclaims the bottom strip for the scanner viewport. The toggle
// at bottom-right is unchanged; tap toggles multi-mode, badge shows
// running count.

struct MultiScanFlashCard: View {
    @ObservedObject var session: MultiScanSession
    let entryId: UUID
    let priceVisible: Bool
    /// When true, the card animates toward the bottom-right toggle
    /// (offset + scale-down + fade) instead of fading in place. Gives
    /// the user a visual cue that the scanned card is going INTO the
    /// stack at the toggle's location. Parent toggles this near the
    /// end of the flash window (~1.5s into a ~2s total).
    let flying: Bool
    let onTap: () -> Void

    private let cardWidth: CGFloat = 200
    /// 2.5 × 3.5 aspect — standard Pokemon card.
    private let cardAspect: CGFloat = 2.5 / 3.5

    /// Offset applied to the card when `flying` is true. Roughly
    /// targets the bottom-right toggle's position relative to the
    /// card's centered start. Exact pixel-match isn't necessary; the
    /// direction + scale-down reads clearly as "the card is going
    /// over there."
    private let flyOffset: CGSize = CGSize(width: 140, height: 200)

    var body: some View {
        // Live lookup from the session so a still-loading price fills in
        // mid-flash without the view needing its own observation. If the
        // entry got removed (clear, swipe-delete, submit success) while
        // the flash was still animating, the overlay collapses to empty.
        if let entry = session.entries.first(where: { $0.id == entryId }) {
            content(entry: entry)
        }
    }

    private func content(entry: MultiScanEntry) -> some View {
        VStack(spacing: 0) {
            Spacer()
            cardBox(entry: entry)
                .offset(flying ? flyOffset : .zero)
                .scaleEffect(flying ? 0.18 : 1.0)
                .opacity(flying ? 0 : 1.0)
            Spacer().frame(height: 140) // sit above the tab bar
        }
        .frame(maxWidth: .infinity)
        // No tap gesture on the outer VStack — Spacers would extend the
        // hit target across the entire viewport and swallow the
        // scanner's tap-to-capture / multi-scan toggle taps while the
        // flash is visible. (Codex P2 review on PR #97.) The tap lives
        // on `cardBox` so only the visible card frame opens the review
        // sheet; the rest of the viewport stays interactive.
    }

    private func cardBox(entry: MultiScanEntry) -> some View {
        ZStack(alignment: .center) {
            cardImage(entry: entry)
                .frame(width: cardWidth, height: cardWidth / cardAspect)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(confidenceColor(entry.confidence), lineWidth: 2),
                )
                .shadow(color: .black.opacity(0.45), radius: 18, x: 0, y: 8)

            if priceVisible {
                priceLabel(entry)
                    .transition(.opacity)
            }
        }
        // Constrain the hit target to the card-sized frame so taps on
        // the surrounding viewport (the scanner tap-to-capture area,
        // the bottom-right toggle) pass through to those handlers
        // instead of being swallowed by the flash overlay.
        .frame(width: cardWidth, height: cardWidth / cardAspect)
        .contentShape(Rectangle())
        .onTapGesture {
            PAHaptics.selection()
            onTap()
        }
    }

    /// Renders the card art. Prefers the pre-fetched `cachedImage`
    /// (populated by `MultiScanSession.loadImage` on append) so the
    /// flash is instantaneous when the image bytes arrived before the
    /// overlay was shown. Falls back to AsyncImage with the default
    /// fade-in disabled — without that override, AsyncImage's built-in
    /// crossfade adds another ~300ms of perceived load even after the
    /// bytes are in hand.
    @ViewBuilder
    private func cardImage(entry: MultiScanEntry) -> some View {
        if let cached = entry.cachedImage {
            Image(uiImage: cached)
                .resizable()
                .aspectRatio(cardAspect, contentMode: .fit)
        } else {
            AsyncImage(
                url: URL(string: entry.match.mirroredPrimaryImageUrl ?? ""),
                transaction: Transaction(animation: nil),
            ) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(cardAspect, contentMode: .fit)
                default:
                    // Pre-load placeholder: a card-shaped silhouette so
                    // the flash's vertical anchor doesn't jump when the
                    // image arrives a frame later.
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.black.opacity(0.35))
                        .overlay(
                            Image(systemName: "rectangle.portrait")
                                .font(.system(size: 32))
                                .foregroundStyle(.white.opacity(0.3)),
                        )
                }
            }
        }
    }

    @ViewBuilder
    private func priceLabel(_ entry: MultiScanEntry) -> some View {
        Group {
            if let price = entry.marketPriceUsd {
                Text(formatPrice(price))
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
            } else {
                // Price still loading — show ellipsis so the user sees
                // SOMETHING in the price slot during the ~200ms gap
                // between the scan landing and CardService returning.
                Text("…")
                    .font(.system(size: 26, weight: .semibold))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(
            Capsule()
                .fill(.black.opacity(0.6))
                .background(
                    Capsule().fill(.ultraThinMaterial),
                ),
        )
        .overlay(
            Capsule().stroke(Color.white.opacity(0.15), lineWidth: 0.5),
        )
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
                    // Disable while a submit is in flight. submit()
                    // captured a snapshot of `entries` before the
                    // await; if the user dismisses the sheet during
                    // that window, scanner.resumeScanning() fires
                    // (via the parent's onChange), the camera
                    // accepts new auto-detect appends, and the
                    // in-flight resolution then clears/replaces
                    // entries based on the stale snapshot — silently
                    // dropping the rows scanned during the await.
                    // (Codex P2 review on PR #83.)
                    Button("Done", action: onDismiss)
                        .disabled(submitting)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !session.entries.isEmpty {
                    footer
                }
            }
            // Pair with the disabled Done button to block swipe-down
            // dismissal during submit — same race protection applies
            // to gesture-driven sheet dismissal.
            .interactiveDismissDisabled(submitting)
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

            HStack(spacing: 6) {
                // Standalone qty label — Stepper's own label is hidden
                // via `.labelsHidden()` so the row stays compact, but
                // the user needs to see the current value before
                // tapping +/- otherwise they're operating blind on
                // what quantity will actually be submitted. (Codex
                // P2 review on PR #83.)
                Text("×\(entry.quantity)")
                    .font(.system(size: 14, weight: .medium))
                    .monospacedDigit()
                    .frame(minWidth: 30, alignment: .trailing)
                Stepper(
                    "",
                    value: Binding(
                        get: { entry.quantity },
                        set: { session.updateQuantity(entryId: entry.id, qty: $0) },
                    ),
                    in: 1...99,
                )
                .labelsHidden()
                .fixedSize()
            }
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
