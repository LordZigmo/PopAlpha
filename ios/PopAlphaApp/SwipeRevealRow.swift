import SwiftUI

// MARK: - Swipe Reveal Row
// Wraps any card-style row and reveals trailing action buttons when the
// user swipes left. Snap logic: reveal when > 50% exposed, close otherwise.
// Confirmation alert fires before the destructive delete action executes.

private let kActionWidth: CGFloat = 72
private let kTotalWidth: CGFloat = kActionWidth * 2   // two actions

struct SwipeRevealModifier: ViewModifier {
    let onEdit: () -> Void
    let onDelete: () -> Void

    @State private var offset: CGFloat = 0
    @State private var showDeleteConfirm = false

    func body(content: Content) -> some View {
        ZStack(alignment: .trailing) {
            // Action strip — revealed as content slides left
            actionStrip
                .frame(width: kTotalWidth)

            // Card content that slides left
            content
                .offset(x: offset)
                .gesture(swipeDrag)
        }
        // Clip so the action strip never bleeds outside the card area
        .clipped()
        .alert("Remove card?", isPresented: $showDeleteConfirm) {
            Button("Remove", role: .destructive) { onDelete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove all lots of this card from your portfolio.")
        }
    }

    // MARK: - Action Strip

    private var actionStrip: some View {
        HStack(spacing: 1) {
            // Edit (…)
            Button {
                close()
                onEdit()
            } label: {
                VStack(spacing: 5) {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .semibold))
                    Text("Edit")
                        .font(.system(size: 10, weight: .medium))
                }
                .foregroundStyle(.white)
                .frame(width: kActionWidth - 1)
                .frame(maxHeight: .infinity)
                .background(Color(red: 0.25, green: 0.25, blue: 0.30))
            }

            // Delete (trash)
            Button {
                close()
                showDeleteConfirm = true
            } label: {
                VStack(spacing: 5) {
                    Image(systemName: "trash.fill")
                        .font(.system(size: 16, weight: .semibold))
                    Text("Delete")
                        .font(.system(size: 10, weight: .medium))
                }
                .foregroundStyle(.white)
                .frame(width: kActionWidth)
                .frame(maxHeight: .infinity)
                .background(Color.red)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
    }

    // MARK: - Drag Gesture

    private var swipeDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let dx = value.translation.width
                // Allow only leftward swipes; add slight resistance past full reveal
                if dx < 0 {
                    if -dx <= kTotalWidth {
                        offset = dx
                    } else {
                        // Rubber-band past the full reveal
                        let overscroll = (-dx - kTotalWidth)
                        offset = -(kTotalWidth + overscroll * 0.2)
                    }
                } else if offset < 0 {
                    // Allow swiping back right
                    offset = min(offset + dx, 0)
                }
            }
            .onEnded { _ in
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    offset = -offset > kTotalWidth * 0.5 ? -kTotalWidth : 0
                }
            }
    }

    // MARK: - Helpers

    private func close() {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) { offset = 0 }
    }
}

extension View {
    /// Adds a left-swipe trailing action strip with an edit and a delete button.
    func swipeRevealActions(
        onEdit: @escaping () -> Void,
        onDelete: @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealModifier(onEdit: onEdit, onDelete: onDelete))
    }
}
