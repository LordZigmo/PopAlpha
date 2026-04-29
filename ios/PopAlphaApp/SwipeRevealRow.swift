import SwiftUI

// MARK: - Swipe Reveal Row
// Wraps any card-style row and reveals trailing action buttons when the
// user swipes left.
//
// Gesture strategy: `.simultaneousGesture` on the outer ZStack so the
// drag runs alongside button taps (not blocked by them) and we explicitly
// guard for horizontal-dominant drags to avoid stealing vertical scroll.

private let kActionWidth: CGFloat = 72
private let kTotalWidth: CGFloat  = kActionWidth * 2  // edit + delete

struct SwipeRevealModifier: ViewModifier {
    let onEdit: () -> Void
    let onDelete: () -> Void

    @State private var offset: CGFloat = 0
    @State private var showDeleteConfirm = false
    // Track whether this drag started as horizontal so we don't flip
    // direction mid-gesture when the finger drifts vertically.
    @State private var isHorizontalDrag = false

    func body(content: Content) -> some View {
        ZStack(alignment: .trailing) {
            actionStrip
                .frame(width: kTotalWidth)

            content
                .offset(x: offset)
        }
        .clipped()
        .simultaneousGesture(swipeDrag)
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
            .buttonStyle(.plain)

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
            .buttonStyle(.plain)
        }
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
    }

    // MARK: - Drag Gesture

    private var swipeDrag: some Gesture {
        DragGesture(minimumDistance: 15, coordinateSpace: .local)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height

                // On the first meaningful movement decide if this is a
                // horizontal drag. If vertical, let the ScrollView handle it.
                if !isHorizontalDrag && (abs(dx) > 8 || abs(dy) > 8) {
                    isHorizontalDrag = abs(dx) > abs(dy)
                }
                guard isHorizontalDrag else { return }

                if dx < 0 {
                    // Swiping left — reveal actions with light rubber-banding
                    let raw = offset + dx - (value.predictedEndTranslation.width - value.translation.width) * 0
                    if -dx <= kTotalWidth {
                        offset = dx
                    } else {
                        let overscroll = -dx - kTotalWidth
                        offset = -(kTotalWidth + overscroll * 0.15)
                    }
                } else if offset < 0 {
                    // Swiping right — close
                    offset = min(offset + dx, 0)
                }
            }
            .onEnded { value in
                guard isHorizontalDrag else {
                    isHorizontalDrag = false
                    return
                }
                isHorizontalDrag = false
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    offset = -offset > kTotalWidth * 0.45 ? -kTotalWidth : 0
                }
            }
    }

    // MARK: - Helpers

    private func close() {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) { offset = 0 }
    }
}

extension View {
    func swipeRevealActions(
        onEdit: @escaping () -> Void,
        onDelete: @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealModifier(onEdit: onEdit, onDelete: onDelete))
    }
}
