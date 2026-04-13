import SwiftUI

// MARK: - Search View

struct SearchView: View {
    var onSelectSlug: ((String) -> Void)?

    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [SearchCardResult] = []
    @State private var isSearching = false
    @State private var searchError: String?
    @State private var hasSearched = false
    @FocusState private var isTextFieldFocused: Bool

    // Card number detection
    private var isCardNumberQuery: Bool {
        let pattern = #"^\s*#?\d+(/\d+)?\s*$"#
        return query.range(of: pattern, options: .regularExpression) != nil
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
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15))
                    .foregroundStyle(PA.Colors.muted)

                TextField("Search cards, sets, numbers...", text: $query)
                    .font(.system(size: 16))
                    .foregroundStyle(PA.Colors.text)
                    .focused($isTextFieldFocused)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)

                if !query.isEmpty {
                    Button {
                        query = ""
                        results = []
                        hasSearched = false
                        searchError = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }
            .padding(10)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Button("Cancel") {
                dismiss()
            }
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(PA.Colors.accent)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .onAppear {
            isTextFieldFocused = true
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
}

// MARK: - Preview

#Preview {
    SearchView()
        .preferredColorScheme(.dark)
}
