import PhotosUI
import Photos
import SwiftUI
import NukeUI

// MARK: - Mode

/// Drives the sheet's UI:
///   .freshPhoto  → user picks a photo, searches for the card, saves.
///                  Primary use: bulk-label photos for the eval corpus.
///   .correction  → user already scanned, got the wrong card; we have
///                  the scan's image_hash in storage already, so the
///                  user just searches for the true card and saves.
enum EvalSeedingMode: Equatable {
    case freshPhoto
    case correction(imageHash: String, predictedSlug: String?)

    var title: String {
        switch self {
        case .freshPhoto: "Seed Eval Corpus"
        case .correction: "Correct This Scan"
        }
    }

    var captureSource: EvalCaptureSource {
        switch self {
        case .freshPhoto: .userPhoto
        case .correction: .userCorrection
        }
    }

    var requiresPhotoPick: Bool {
        if case .freshPhoto = self { return true }
        return false
    }
}

// MARK: - View

struct EvalSeedingView: View {
    let mode: EvalSeedingMode
    @Binding var isPresented: Bool

    @State private var pickerItem: PhotosPickerItem?
    @State private var pickedImage: UIImage?
    // PHAsset identifier of the photo the user picked from their
    // library. We capture it on photo-pick (NOT on save) because
    // PhotosPickerItem.itemIdentifier is the PHAsset.localIdentifier
    // when the picker is configured with photoLibrary: .shared(),
    // which it is. Used after successful upload to optionally delete
    // the photo from the user's library so they can keep tapping the
    // top photo to seed the next card without uploading duplicates.
    @State private var pickedAssetIdentifier: String?
    @State private var searchQuery: String = ""
    @State private var searchResults: [SearchCardResult] = []
    @State private var selectedCard: SearchCardResult?
    @State private var isSearching = false
    @State private var isSaving = false
    @State private var saveResult: SaveOutcome?
    @State private var notes: String = ""
    // Drives the post-save "Delete from your photos?" alert. We don't
    // delete silently — iOS forces its own confirmation on top of
    // ours anyway, but a soft pre-prompt makes the workflow read
    // better ("just saved as journey-together-23-combusken — clear
    // the original from your library?") and gives the operator one
    // chance to skip without seeing the system dialog at all.
    @State private var pendingLibraryDeleteAssetId: String?
    @FocusState private var searchFocused: Bool

    private enum SaveOutcome: Equatable {
        case success(String)   // slug
        case failure(String)   // error message
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    headerSection
                    imageSection
                    searchSection
                    if let card = selectedCard {
                        selectedCardSection(card)
                    }
                    notesSection
                    saveButton
                    if let outcome = saveResult {
                        outcomeBanner(outcome)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 40)
            }
            .background(PA.Colors.background)
            .navigationTitle(mode.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
        .task(id: searchQuery) {
            await runSearchIfNeeded()
        }
        // Two-step delete confirmation. Our alert is the soft prompt
        // ("you just uploaded — also clear the original from your
        // library?"), and PHAssetChangeRequest then triggers iOS's
        // native confirmation. The double-prompt feels right for
        // this destructive action — accidentally tapping Delete in
        // a fast labeling rhythm shouldn't silently lose the user's
        // original photo.
        .alert(
            "Delete photo from library?",
            isPresented: Binding(
                get: { pendingLibraryDeleteAssetId != nil },
                set: { newValue in
                    if !newValue { pendingLibraryDeleteAssetId = nil }
                },
            ),
        ) {
            Button("Delete", role: .destructive) {
                if let assetId = pendingLibraryDeleteAssetId {
                    pendingLibraryDeleteAssetId = nil
                    deletePickedAssetFromLibrary(assetId)
                }
            }
            Button("Skip") {
                pendingLibraryDeleteAssetId = nil
                resetPickerForNextCard()
            }
        } message: {
            Text(
                "Saved to the eval corpus. Removing the photo from your library lets you keep tapping the top photo to seed the next card without uploading duplicates."
            )
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var headerSection: some View {
        switch mode {
        case .freshPhoto:
            Text("Pick a photo, search for the correct card, and save it as ground truth for the scanner eval.")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        case .correction(_, let predictedSlug):
            VStack(alignment: .leading, spacing: 6) {
                Text("The scanner thought this was:")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
                Text(predictedSlug ?? "(unknown)")
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundStyle(PA.Colors.text)
                Text("Search for the actual card below to correct the label.")
                    .font(PA.Typography.caption)
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    // MARK: - Image section

    @ViewBuilder
    private var imageSection: some View {
        switch mode {
        case .freshPhoto:
            freshPhotoPicker
        case .correction(let imageHash, _):
            imageHashBadge(imageHash)
        }
    }

    private var freshPhotoPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Photo")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            PhotosPicker(
                selection: $pickerItem,
                matching: .images,
                photoLibrary: .shared()
            ) {
                if let pickedImage {
                    Image(uiImage: pickedImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxHeight: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    emptyPickerFrame
                }
            }
            .onChange(of: pickerItem) { _, newItem in
                guard let newItem else { return }
                // PhotosPickerItem.itemIdentifier resolves to the
                // PHAsset.localIdentifier when the picker is bound to
                // photoLibrary: .shared(). Caching it here (synchronous,
                // doesn't require photo-library permission yet) so we
                // can offer "Delete from library" after upload.
                pickedAssetIdentifier = newItem.itemIdentifier
                Task {
                    if
                        let data = try? await newItem.loadTransferable(type: Data.self),
                        let image = UIImage(data: data)
                    {
                        await MainActor.run { pickedImage = image }
                    }
                }
            }
        }
    }

    private var emptyPickerFrame: some View {
        VStack(spacing: 6) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
            Text("Tap to pick a photo")
                .font(PA.Typography.caption)
                .foregroundStyle(PA.Colors.muted)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 180)
        .glassSurface(radius: 12)
    }

    private func imageHashBadge(_ hash: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.viewfinder")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PA.Colors.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Scan image")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                Text(String(hash.prefix(12)) + "…")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(PA.Colors.muted)
            }
            Spacer()
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    // MARK: - Search

    private var searchSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Correct card")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                TextField("Search by name, set, or number", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($searchFocused)
                    .foregroundStyle(PA.Colors.text)
                if !searchQuery.isEmpty {
                    Button {
                        searchQuery = ""
                        searchResults = []
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(PA.Colors.muted)
                    }
                }
            }
            .padding(10)
            .glassSurface(radius: 10)

            if isSearching && searchResults.isEmpty && !searchQuery.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.7)
                    Text("Searching…")
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                }
            }

            // Hide the dropdown once a card is picked — the selected
            // card section below is the committed state, and lingering
            // results just crowd the UI. Also clear the query + results
            // so tapping Save or changing notes doesn't re-trigger a
            // search on the same text.
            if !searchResults.isEmpty && selectedCard == nil {
                LazyVStack(spacing: 6) {
                    ForEach(searchResults.prefix(8)) { card in
                        Button {
                            selectedCard = card
                            searchFocused = false
                            searchQuery = ""
                            searchResults = []
                        } label: {
                            SearchSuggestionCell(card: card)
                                .glassSurface(radius: 10)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func selectedCardSection(_ card: SearchCardResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Selected")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            HStack(spacing: 12) {
                if let url = card.imageURL {
                    LazyImage(url: url) { state in
                        if let image = state.image {
                            image
                                .resizable()
                                .aspectRatio(63.0 / 88.0, contentMode: .fill)
                        } else {
                            Color.clear
                        }
                    }
                    .frame(width: 48, height: 67)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.canonicalName)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                    if let setName = card.setName {
                        Text(setName)
                            .font(PA.Typography.caption)
                            .foregroundStyle(PA.Colors.muted)
                    }
                    Text(card.canonicalSlug)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(PA.Colors.muted.opacity(0.7))
                }
                Spacer()
                Button {
                    selectedCard = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
            .padding(12)
            .glassSurface(radius: 12)
        }
    }

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes (optional)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)
            TextField("e.g. held by corners, dim lighting", text: $notes)
                .textFieldStyle(.plain)
                .padding(10)
                .glassSurface(radius: 10)
        }
    }

    // MARK: - Save

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack {
                if isSaving { ProgressView().tint(PA.Colors.background) }
                Text(isSaving ? "Saving…" : "Save to eval corpus")
                    .font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(canSave ? PA.Colors.accent : PA.Colors.accent.opacity(0.35))
            .foregroundStyle(PA.Colors.background)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canSave)
    }

    @ViewBuilder
    private func outcomeBanner(_ outcome: SaveOutcome) -> some View {
        switch outcome {
        case .success(let slug):
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(PA.Colors.positive)
                Text("Saved — \(slug)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
            }
            .padding(10)
            .glassSurface(radius: 10)
        case .failure(let message):
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(PA.Colors.negative)
                Text(message)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(3)
            }
            .padding(10)
            .glassSurface(radius: 10)
        }
    }

    private var canSave: Bool {
        guard !isSaving, let _ = selectedCard else { return false }
        if mode.requiresPhotoPick && pickedImage == nil { return false }
        return true
    }

    // MARK: - Actions

    private func runSearchIfNeeded() async {
        let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            await MainActor.run {
                searchResults = []
                isSearching = false
            }
            return
        }
        await MainActor.run { isSearching = true }
        do {
            let results = try await SearchService.shared.search(query: trimmed)
            await MainActor.run {
                searchResults = results
                isSearching = false
            }
        } catch {
            await MainActor.run {
                searchResults = []
                isSearching = false
            }
        }
    }

    private func save() async {
        guard let card = selectedCard else { return }
        isSaving = true
        defer { isSaving = false }

        do {
            let response: ScanEvalPromoteResponse
            switch mode {
            case .freshPhoto:
                guard let image = pickedImage else { return }
                response = try await ScanService.promoteEvalFromBytes(
                    image: image,
                    canonicalSlug: card.canonicalSlug,
                    source: .userPhoto,
                    notes: notes.isEmpty ? nil : notes
                )
            case .correction(let imageHash, let predictedSlug):
                let augmentedNotes = [
                    notes.isEmpty ? nil : notes,
                    predictedSlug.map { "model predicted \($0)" }
                ].compactMap { $0 }.joined(separator: " | ")
                response = try await ScanService.promoteEvalFromHash(
                    imageHash: imageHash,
                    canonicalSlug: card.canonicalSlug,
                    source: .userCorrection,
                    notes: augmentedNotes.isEmpty ? nil : augmentedNotes
                )
            }

            await MainActor.run {
                if response.ok {
                    saveResult = .success(response.canonicalSlug ?? card.canonicalSlug)
                    PAHaptics.success()
                    // If the user picked from their library AND we
                    // captured an asset identifier, surface the
                    // delete-from-library prompt. Skipped automatically
                    // for the .correction path (no photo picker) and
                    // for picker selections that didn't yield an
                    // identifier (rare — usually means the asset was
                    // a transient screenshot or shared-album item).
                    if mode.requiresPhotoPick, let assetId = pickedAssetIdentifier {
                        pendingLibraryDeleteAssetId = assetId
                    }
                } else {
                    saveResult = .failure(response.error ?? "Save failed")
                }
            }
        } catch {
            await MainActor.run {
                saveResult = .failure(error.localizedDescription)
            }
        }
    }

    /// Removes the just-uploaded source photo from the user's photo
    /// library. iOS shows its own native confirmation dialog when
    /// PHAssetChangeRequest.deleteAssets is invoked, so the user
    /// gets a final yes/no even if they accidentally tap our
    /// "Delete" button. On success, also resets the picker state
    /// so the next card's photo can be picked fresh.
    private func deletePickedAssetFromLibrary(_ assetIdentifier: String) {
        // Authorization status is also auto-prompted by performChanges
        // on first call, but checking ahead of time lets us bail out
        // cleanly with a visible failure message if the user has
        // explicitly denied photo library access.
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .denied || status == .restricted {
            saveResult = .failure(
                "Photo library access denied — enable in Settings → Privacy → Photos to remove uploaded photos automatically."
            )
            return
        }

        let assets = PHAsset.fetchAssets(
            withLocalIdentifiers: [assetIdentifier],
            options: nil,
        )
        guard assets.count > 0 else {
            // Asset went missing between pick and delete (user could
            // have manually deleted, or it was a transient resource).
            // Just clear local state without complaining loudly.
            resetPickerForNextCard()
            return
        }

        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets)
        }) { success, error in
            DispatchQueue.main.async {
                if success {
                    PAHaptics.tap()
                    resetPickerForNextCard()
                } else if let error {
                    // User probably tapped "Don't Allow" on the system
                    // confirmation. Don't treat as a hard failure —
                    // they got what they asked for; just leave state
                    // as-is so they can pick a different photo or try
                    // delete again.
                    let nsError = error as NSError
                    if nsError.code != PHPhotosError.userCancelled.rawValue {
                        saveResult = .failure(
                            "Couldn't delete photo: \(error.localizedDescription)"
                        )
                    }
                }
            }
        }
    }

    /// Clears the picker / selected-card / search state so the operator
    /// can immediately tap "Photo" again and the system will surface
    /// the new top-of-library picture (now that the previous one is
    /// gone). Notes and saveResult banner are intentionally preserved
    /// so the operator can confirm what just happened before the next
    /// upload.
    private func resetPickerForNextCard() {
        pickerItem = nil
        pickedImage = nil
        pickedAssetIdentifier = nil
        selectedCard = nil
        searchQuery = ""
        searchResults = []
        pendingLibraryDeleteAssetId = nil
    }
}
