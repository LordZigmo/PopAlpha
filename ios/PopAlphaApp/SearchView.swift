import SwiftUI

// MARK: - Search View

/// Cancel-button behavior for the search bar.
///
/// Different hosts want different things from a Cancel button:
/// - A modal sheet wants "always visible, dismisses the sheet."
/// - A tab root wants "appears only while the user is searching,
///   clears the query and unfocuses to back out cleanly."
enum SearchCancelMode {
    /// Never show the Cancel button.
    case hidden
    /// Always show. Tap calls `dismiss()` (sheet/fullScreenCover hosts).
    case dismiss
    /// Show only when the field is focused or has text. Tap clears
    /// the query and unfocuses, returning to the idle state.
    case clearOnActive
}

struct SearchView: View {
    var onSelectSlug: ((String) -> Void)?
    var onSelectCard: ((SearchCardResult) -> Void)?
    // Hosting context flags. Defaults preserve sheet/fullScreenCover
    // behavior; the Search tab overrides both so the keyboard doesn't
    // slam up on tab selection / cold launch and the Cancel button
    // clears-and-unfocuses instead of dismissing.
    var cancelMode: SearchCancelMode = .dismiss
    var autofocusOnAppear: Bool = true
    // When true, fetch the authed user's watchlist movers and surface
    // them under recents in the idle state. Off by default so the
    // legacy fullScreenCover entry from Marketplace stays lean.
    var showsCollectorSuggestions: Bool = false

    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [SearchCardResult] = []
    @State private var isSearching = false
    @State private var searchError: String?
    @State private var hasSearched = false
    @State private var watchlistCards: [SearchCardResult] = []
    @FocusState private var isTextFieldFocused: Bool
    @ObservedObject private var recents = RecentSearchStore.shared

    // Card number detection
    private var isCardNumberQuery: Bool {
        let pattern = #"^\s*#?\d+(/\d+)?\s*$"#
        return query.range(of: pattern, options: .regularExpression) != nil
    }

    private var shouldShowCancelButton: Bool {
        switch cancelMode {
        case .hidden:
            return false
        case .dismiss:
            return true
        case .clearOnActive:
            return !query.isEmpty || isTextFieldFocused
        }
    }

    private func handleCancelTap() {
        switch cancelMode {
        case .hidden:
            return
        case .dismiss:
            dismiss()
        case .clearOnActive:
            query = ""
            results = []
            hasSearched = false
            searchError = nil
            isTextFieldFocused = false
        }
    }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            VStack(spacing: 0) {
                searchBar
                Divider().background(PA.Colors.border)

                if isSearching && results.isEmpty {
                    loadingState
                } else if let error = searchError {
                    errorState(error)
                } else if results.isEmpty && hasSearched {
                    emptyState
                } else if results.isEmpty {
                    idleState
                } else {
                    resultsList
                }
            }
        }
        .task(id: query) {
            await debouncedSearch()
        }
        .task {
            guard showsCollectorSuggestions else { return }
            await loadWatchlistSuggestions()
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15))
                    .foregroundStyle(PA.Colors.muted)
                    // Decorative — TextField placeholder is the field's hint.
                    .accessibilityHidden(true)

                TextField("Search cards, sets, numbers...", text: $query)
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.text)
                    .focused($isTextFieldFocused)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)

                // Show the clear control whenever there's text OR the field is
                // focused — so backspacing to empty still leaves a tap target to
                // drop the keyboard (an empty, focused field otherwise strands it).
                if !query.isEmpty || isTextFieldFocused {
                    Button {
                        if query.isEmpty {
                            // Already empty → the tap just dismisses the keyboard.
                            isTextFieldFocused = false
                        } else {
                            query = ""
                            results = []
                            hasSearched = false
                            searchError = nil
                        }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(PA.Colors.muted)
                    }
                    .accessibilityLabel(query.isEmpty ? "Dismiss keyboard" : "Clear search")
                }
            }
            .padding(10)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            if shouldShowCancelButton {
                Button("Cancel") {
                    handleCancelTap()
                }
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(PA.Colors.accent)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .animation(.easeInOut(duration: 0.18), value: shouldShowCancelButton)
        .onAppear {
            if autofocusOnAppear {
                isTextFieldFocused = true
            }
        }
    }

    // MARK: - Results

    private var resultsList: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                // Card number hint
                if isCardNumberQuery {
                    HStack(spacing: 6) {
                        Image(systemName: "number")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PA.Colors.accent)

                        Text("Searching by card number")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                }

                ForEach(results) { card in
                    Button {
                        recents.record(card)
                        onSelectCard?(card)
                        onSelectSlug?(card.canonicalSlug)
                        dismiss()
                    } label: {
                        SearchResultCell(card: card)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(0..<6, id: \.self) { _ in
                        skeletonCell
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
        }
    }

    private var skeletonCell: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
                .frame(width: 48, height: 67)

            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 140, height: 14)
                RoundedRectangle(cornerRadius: 4)
                    .fill(PA.Colors.surfaceSoft)
                    .frame(width: 100, height: 12)
            }
            Spacer()
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.negative)

            Text("Search failed")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text(message)
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)

            Button("Retry") {
                Task { await performSearch() }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PA.Colors.background)
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
            .background(PA.Colors.accent)
            .clipShape(Capsule())

            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "magnifyingglass")
                .font(.system(size: 28))
                .foregroundStyle(PA.Colors.muted)

            Text("No results found")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.text)

            Text("Try a different search term or card number.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
            Spacer()
        }
    }

    private var idleState: some View {
        Group {
            if recents.recents.isEmpty && watchlistCards.isEmpty {
                emptyIdleState
            } else {
                suggestionsList
            }
        }
    }

    private var suggestionsList: some View {
        ScrollView {
            LazyVStack(spacing: 24) {
                if !recents.recents.isEmpty {
                    suggestionSection(
                        title: "Recent",
                        cards: recents.recents,
                        trailing: AnyView(
                            Button("Clear") {
                                recents.clear()
                            }
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                            .accessibilityLabel("Clear recent searches")
                        )
                    )
                }

                if !watchlistCards.isEmpty {
                    suggestionSection(
                        title: "From your watchlist",
                        cards: watchlistCards,
                        trailing: nil
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
    }

    private func suggestionSection(
        title: String,
        cards: [SearchCardResult],
        trailing: AnyView?
    ) -> some View {
        VStack(spacing: 8) {
            HStack {
                Text(title)
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                trailing
            }
            .padding(.horizontal, 4)

            ForEach(cards) { card in
                Button {
                    recents.record(card)
                    onSelectCard?(card)
                    onSelectSlug?(card.canonicalSlug)
                    dismiss()
                } label: {
                    SearchResultCell(card: card)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyIdleState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "magnifyingglass")
                .font(.system(size: 32))
                .foregroundStyle(PA.Colors.muted.opacity(0.4))

            Text("Search for cards")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            VStack(spacing: 4) {
                Text("Try card names, set names, or numbers")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted.opacity(0.6))
                Text("e.g. \"Charizard\", \"Prismatic\", \"#25\"")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
            }
            Spacer()
        }
    }

    // MARK: - Search Logic

    private func debouncedSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty else {
            results = []
            hasSearched = false
            searchError = nil
            return
        }

        // 240ms debounce — if task is cancelled (query changed), this throws
        try? await Task.sleep(for: .milliseconds(240))

        guard !Task.isCancelled else { return }

        await performSearch()
    }

    private func performSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSearching = true
        searchError = nil

        do {
            let cards = try await SearchService.shared.search(query: trimmed)
            guard !Task.isCancelled else { return }
            results = cards
            hasSearched = true
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            searchError = error.localizedDescription
        }

        isSearching = false
    }

    // Watchlist movers from /api/homepage/me — same payload the Market
    // tab already loads. fetchHomepageMe returns nil for guests, so the
    // section just doesn't render in that case. Failures are intentionally
    // silent: the section is a nice-to-have, the search field still works.
    private func loadWatchlistSuggestions() async {
        do {
            guard let me = try await CardService.shared.fetchHomepageMe() else { return }
            guard !Task.isCancelled else { return }
            watchlistCards = me.watchlistMovers.map { mover in
                SearchCardResult(
                    canonicalSlug: mover.slug,
                    canonicalName: mover.name,
                    setName: mover.setName,
                    cardNumber: nil,
                    year: mover.year,
                    primaryImageUrl: mover.imageUrl,
                    score: nil
                )
            }
        } catch {
            // intentional: section just doesn't render on error
        }
    }
}

// MARK: - Preview

#Preview {
    SearchView()
}
