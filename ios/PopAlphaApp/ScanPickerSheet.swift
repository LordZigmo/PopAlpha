import SwiftUI
import NukeUI

/// Shown after a medium-confidence scan when the identifier narrowed
/// the card to a short list but couldn't pick a single winner with
/// high confidence. Lets the user tap the correct match from the
/// top 3 candidates. A tap:
///   1. Fires the promote-to-eval-corpus API so the (image, chosen
///      slug) pair lands in scan_eval_images as a user_correction
///      — this feeds future fine-tuning + eval coverage.
///   2. Navigates into CardDetailView for the chosen card.
///
/// When none of the top 3 are right, the operator taps
/// "None of these — search for the card" and the sheet swaps to a
/// search mode where they can find the actual card by name and
/// promote that instead. The search picks the same correction code
/// path so eval-corpus accounting stays consistent.
///
/// Only surfaced for confidence == "medium". High-confidence auto-
/// navigates and uses CardDetailView's own correction prompt.
/// Low-confidence re-arms silently (the matches are too noisy to be
/// worth showing).
struct ScanPickerSheet: View {
    let matches: [ScanMatch]
    let imageHash: String?
    /// Source UIImage for offline scans, retained by ScannerHost so
    /// the correction-promote flow can re-upload bytes when scan-uploads
    /// doesn't have them. Nil for online scans (server already uploaded).
    /// When present, picker/search promotion uses
    /// `promoteEvalFromBytes` instead of `promoteEvalFromHash`.
    var scanImage: UIImage? = nil
    let scanLanguage: ScanLanguage
    /// What on-device OCR pulled from the captured frame. Used by the
    /// debug overlay (DEBUG-only) so during sprint real-device testing
    /// the operator can see whether Vision actually extracted the
    /// printed collector number / set name. Default-nil keeps the
    /// initializer source-compatible with existing callers.
    var ocrCardNumber: String? = nil
    var ocrSetHint: String? = nil
    /// Day 2 retrieval path that resolved this scan
    /// (`vision_only`, `ocr_direct_unique`, `ocr_direct_narrow`,
    /// `ocr_intersect_unique`, `ocr_intersect_narrow`). Surfaced in the
    /// DEBUG overlay so during sprint real-device testing the operator
    /// can see which signal won — direct DB lookup vs. CLIP+OCR
    /// intersection vs. CLIP-only fallback. Default-nil keeps the
    /// initializer source-compatible with existing callers.
    var winningPath: String? = nil
    let onPick: (ScanMatch) -> Void
    let onDismiss: () -> Void
    /// Called after a correction successfully posts to the server.
    /// ScannerTabView wires this to `OfflineScanOrchestrator.syncAnchorsInBackground`
    /// so the just-submitted user_correction anchor reaches the
    /// device before the user's next scan. Optional so existing
    /// callers don't need to update.
    var onCorrectionSubmitted: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var promoting = false

    /// Picker (top-3) vs. search (autocomplete the catalog) mode.
    /// When user hits "None of these," we swap content within the
    /// SAME sheet rather than presenting a nested sheet — fewer
    /// dismiss-animation glitches on narrow screens.
    @State private var mode: Mode = .picker
    @State private var searchQuery: String = ""
    @State private var searchResults: [SearchCardResult] = []
    @State private var isSearching: Bool = false
    @State private var searchError: String?
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var searchFocused: Bool

    private enum Mode {
        case picker
        case search
    }

    private var topMatches: [ScanMatch] {
        Array(matches.prefix(3))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .picker:
                    pickerBody
                case .search:
                    searchBody
                }
            }
            .background(PA.Colors.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(promoting)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            // In search mode, left button goes back to picker.
            // In picker mode, left button dismisses the sheet entirely.
            Button {
                if mode == .search {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        searchTask?.cancel()
                        mode = .picker
                    }
                } else {
                    onDismiss()
                    dismiss()
                }
            } label: {
                Image(systemName: mode == .search ? "chevron.left" : "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    // MARK: - Picker mode

    private var pickerBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            pickerHeader
            matchList
            Spacer(minLength: 12)
            #if DEBUG
            ocrDebugStrip
            #endif
            noneOfTheseButton
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
    }

    private var pickerHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Which card did you scan?")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("We narrowed it down but aren't 100% sure. Tap the right one.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(.bottom, 16)
    }

    private var matchList: some View {
        VStack(spacing: 10) {
            ForEach(Array(topMatches.enumerated()), id: \.element.slug) { index, match in
                Button {
                    handlePickerPick(match)
                } label: {
                    matchRow(match: match, rank: index + 1)
                }
                .buttonStyle(.plain)
                .disabled(promoting)
            }
        }
    }

    private func matchRow(match: ScanMatch, rank: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(PA.Colors.muted)
                .frame(width: 22, height: 22)
                .background(PA.Colors.surfaceSoft)
                .clipShape(Circle())

            if let urlString = match.mirroredPrimaryImageUrl,
               let url = URL(string: urlString) {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        thumbnailPlaceholder
                    }
                }
                .frame(width: 52, height: 73)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                thumbnailPlaceholder
                    .frame(width: 52, height: 73)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(match.canonicalName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    if let setName = match.setName {
                        Text(setName)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                            .lineLimit(1)
                    }
                    if let number = match.cardNumber {
                        Text("·")
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.border)
                        Text("#\(number)")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(PA.Colors.muted)
                    }
                }

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(PA.Colors.surfaceSoft)
                        Capsule()
                            .fill(PA.Colors.accent.opacity(0.8))
                            .frame(width: geo.size.width * CGFloat(max(0, min(1, match.similarity))))
                    }
                }
                .frame(height: 3)
            }

            Spacer()

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

    private var noneOfTheseButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                mode = .search
                // Defer focus so the field exists in the hierarchy.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    searchFocused = true
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .medium))
                Text("None of these — search for the card")
                    .font(.system(size: 14, weight: .medium))
            }
            .foregroundStyle(PA.Colors.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(promoting)
        .padding(.top, 4)
    }

    // MARK: - Search mode

    private var searchBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            searchHeader
            searchField
                .padding(.bottom, 12)
            searchResultsScroll
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
    }

    private var searchHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Find the right card")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
            Text("Search the catalog and tap the card you actually scanned. We'll log the correction so the scanner learns.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .padding(.bottom, 16)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PA.Colors.muted)

            TextField(
                "",
                text: $searchQuery,
                prompt: Text("Search by name or set")
                    .foregroundStyle(PA.Colors.muted.opacity(0.6))
            )
            .focused($searchFocused)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .foregroundStyle(PA.Colors.text)
            .onChange(of: searchQuery) { _, newValue in
                triggerSearch(for: newValue)
            }

            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                    searchResults = []
                    searchError = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(PA.Colors.muted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(PA.Colors.surfaceSoft)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private var searchResultsScroll: some View {
        if isSearching && searchResults.isEmpty {
            VStack(spacing: 12) {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(PA.Colors.accent)
                Text("Searching…")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = searchError {
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(PA.Colors.negative)
                Text(error)
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 16)
        } else if searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 28))
                    .foregroundStyle(PA.Colors.muted.opacity(0.4))
                Text("Type a card name to search")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if searchResults.isEmpty {
            VStack(spacing: 8) {
                Text("No matches")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
                Text("Try a shorter query or include the set name.")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted.opacity(0.7))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(searchResults) { result in
                        Button {
                            handleSearchPick(result)
                        } label: {
                            SearchResultCell(card: result)
                        }
                        .buttonStyle(.plain)
                        .disabled(promoting)
                    }
                }
                .padding(.bottom, 16)
            }
        }
    }

    // MARK: - Debug overlay (DEBUG-only — picker mode footer)

    #if DEBUG
    @ViewBuilder
    private var ocrDebugStrip: some View {
        let numberDisplay = ocrCardNumber?.isEmpty == false ? ocrCardNumber! : "—"
        let hintDisplay = ocrSetHint?.isEmpty == false ? ocrSetHint! : "—"
        let pathDisplay = winningPath?.isEmpty == false ? winningPath! : "—"
        VStack(alignment: .leading, spacing: 4) {
            Text("OCR debug (DEBUG builds only)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
            HStack(spacing: 12) {
                Text("card_number: \(numberDisplay)")
                    .font(.system(size: 11, design: .monospaced))
                Text("set_hint: \(hintDisplay)")
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(PA.Colors.text.opacity(0.7))
            Text("path: \(pathDisplay)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(PA.Colors.text.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.muted.opacity(0.08))
        )
        .padding(.bottom, 12)
    }
    #endif

    // MARK: - Actions

    /// User picked one of the top-3 server-suggested matches.
    private func handlePickerPick(_ match: ScanMatch) {
        guard !promoting else { return }
        promoting = true
        PAHaptics.tap()

        // Fire-and-forget correction. Premium offline scans go through
        // /api/scan/correction (user-gated, anchor-only) — pre-2026-05-02
        // we hit /api/admin/scan-eval/promote which 401'd for non-admin
        // users AND triggered an aggressive auth teardown that signed
        // them out of their own session. The new endpoint just writes
        // the kNN anchor; admin curation of the eval corpus stays on
        // the testtube/EvalSeedingView path.
        if let bytes = scanImage {
            let slug = match.slug
            let lang = scanLanguage
            let store = onCorrectionSubmitted
            Task.detached {
                let result = try? await ScanService.submitCorrection(
                    image: bytes,
                    canonicalSlug: slug,
                    language: lang,
                    notes: "picker-sheet-select",
                )
                if result?.ok == true {
                    // Trigger an anchor sync so the next scan can
                    // see this correction. Non-blocking; the picker
                    // dismiss has already navigated.
                    await MainActor.run { store?() }
                }
            }
        }

        onPick(match)
        dismiss()
    }

    /// User searched the catalog and tapped a result. Promote with the
    /// chosen slug (ground truth, even though the scanner didn't
    /// suggest it) and navigate via onPick. The synthesized ScanMatch
    /// has similarity=1.0 because this is a manual user pick — the
    /// detail view's score badge interprets that as "user-confirmed."
    private func handleSearchPick(_ result: SearchCardResult) {
        guard !promoting else { return }
        promoting = true
        PAHaptics.tap()

        // Same anchor-only correction path as handlePickerPick — see
        // notes there for why we stopped hitting the admin promote
        // endpoint from the picker.
        if let bytes = scanImage {
            let slug = result.canonicalSlug
            let lang = scanLanguage
            let store = onCorrectionSubmitted
            Task.detached {
                let r = try? await ScanService.submitCorrection(
                    image: bytes,
                    canonicalSlug: slug,
                    language: lang,
                    notes: "picker-sheet-search-select",
                )
                if r?.ok == true {
                    await MainActor.run { store?() }
                }
            }
        }

        let synthesized = ScanMatch(
            slug: result.canonicalSlug,
            canonicalName: result.canonicalName,
            language: nil,
            setName: result.setName,
            cardNumber: result.cardNumber,
            variant: nil,
            mirroredPrimaryImageUrl: result.primaryImageUrl,
            similarity: 1.0
        )
        onPick(synthesized)
        dismiss()
    }

    /// Debounced search trigger. 250ms feels responsive without
    /// firing a request on every keystroke. Cancels any in-flight
    /// search when a new keystroke arrives.
    private func triggerSearch(for raw: String) {
        searchTask?.cancel()
        searchError = nil

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            do {
                let results = try await SearchService.shared.search(query: trimmed)
                if Task.isCancelled { return }
                await MainActor.run {
                    self.searchResults = results
                    self.isSearching = false
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    self.searchError = (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                    self.isSearching = false
                }
            }
        }
    }
}
