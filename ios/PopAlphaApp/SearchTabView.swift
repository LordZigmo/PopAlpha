import SwiftUI

// MARK: - Search Tab
//
// Tab-root host for SearchView. Wraps the existing search UI in a
// NavigationStack so result taps push CardDetailView in-place instead
// of dismissing a fullScreenCover (the legacy entry point from
// MarketplaceView, still active).
//
// Re-tap-to-scroll-to-top is intentionally deferred — it requires a
// ScrollViewReader inside SearchView and intercepting the tab-selection
// binding's setter in ContentView to detect re-taps. Out of scope for
// the initial Activity → Search swap; revisit when adding Apple-Music-
// style tab affordances.

struct SearchTabView: View {
    @State private var selectedCard: MarketCard?

    var body: some View {
        NavigationStack {
            SearchView(
                onSelectCard: { result in
                    selectedCard = MarketCard.stub(
                        slug: result.canonicalSlug,
                        name: result.canonicalName,
                        setName: result.setName ?? "",
                        cardNumber: result.cardNumber ?? "",
                        imageURL: result.imageURL
                    )
                },
                cancelMode: .clearOnActive,
                autofocusOnAppear: false,
                showsCollectorSuggestions: true
            )
            .navigationDestination(item: $selectedCard) { card in
                CardDetailView(card: card)
            }
        }
    }
}

#Preview {
    SearchTabView()
        .preferredColorScheme(.dark)
}
