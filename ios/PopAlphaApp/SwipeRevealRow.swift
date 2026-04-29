import SwiftUI

// MARK: - Swipe Reveal Row
// Wraps any card-style row with trailing swipe-to-reveal edit/delete buttons.
//
// Gesture strategy:
//   • highPriorityGesture on the outer ZStack: once the DragGesture
//     activates (≥10pt of movement) it preempts inner Buttons, so a swipe
//     never accidentally fires the row's tap action. Pure taps stay below
//     the 10pt threshold and reach the buttons normally.
//   • On the first 10pt of movement, decide whether the drag is horizontal
//     or vertical. Vertical → ignore entirely (let ScrollView scroll).
//     Horizontal → lock scroll via the isScrollLocked binding and track.
//   • offset is always relative to startOffset captured at gesture begin,
//     so the card can be swiped from any position (already-open etc.).

private let kActionWidth: CGFloat = 72
private let kTotalWidth:  CGFloat = kActionWidth * 2

struct SwipeRevealModifier: ViewModifier {
    @Binding var isScrollLocked: Bool
    let onEdit:   () -> Void
    let onDelete: () -> Void

    @State private var offset:           CGFloat = 0
    @State private var startOffset:      CGFloat = 0
    @State private var dragAxis:         DragAxis = .undecided
    @State private var showDeleteConfirm = false

    private enum DragAxis { case undecided, horizontal, vertical }

    func body(content: Content) -> some View {
        ZStack(alignment: .trailing) {
            actionStrip
                .frame(width: kTotalWidth)

            content
                .offset(x: offset)
        }
        .clipped()
        .highPriorityGesture(swipeDrag)
        .alert("Remove card?", isPresented: $showDeleteConfirm) {
            Button("Remove", role: .destructive) { onDelete() }
            Button("Cancel",  role: .cancel)      {}
        } message: {
            Text("This will remove all lots of this card from your portfolio.")
        }
    }

    // MARK: - Action Strip

    private var actionStrip: some View {
        HStack(spacing: 1) {
            Button {
                close(); onEdit()
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

            Button {
                close(); showDeleteConfirm = true
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
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height

                // Axis decision: wait for 10 pt of movement before committing
                if dragAxis == .undecided {
                    guard abs(dx) > 10 || abs(dy) > 10 else { return }
                    dragAxis = abs(dx) > abs(dy) ? .horizontal : .vertical
                    startOffset = offset
                    if dragAxis == .horizontal { isScrollLocked = true }
                }

                guard dragAxis == .horizontal else { return }

                // Direct 1:1 tracking from where the card started this gesture
                let candidate = startOffset + dx
                // Clamp: can't go right past 0, slight resistance past full reveal
                if candidate >= 0 {
                    offset = 0
                } else if candidate < -kTotalWidth {
                    let overscroll = -(candidate + kTotalWidth)
                    offset = -(kTotalWidth + overscroll * 0.2)
                } else {
                    offset = candidate
                }
            }
            .onEnded { value in
                defer {
                    dragAxis = .undecided
                    isScrollLocked = false
                }
                guard dragAxis == .horizontal else { return }

                withAnimation(.interpolatingSpring(stiffness: 300, damping: 30)) {
                    offset = -offset > kTotalWidth * 0.45 ? -kTotalWidth : 0
                }
            }
    }

    // MARK: - Helpers

    private func close() {
        withAnimation(.interpolatingSpring(stiffness: 300, damping: 30)) { offset = 0 }
    }
}

extension View {
    func swipeRevealActions(
        isScrollLocked: Binding<Bool>,
        onEdit:         @escaping () -> Void,
        onDelete:       @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealModifier(
            isScrollLocked: isScrollLocked,
            onEdit:   onEdit,
            onDelete: onDelete
        ))
    }
}
