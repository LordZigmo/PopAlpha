import SwiftUI
import NukeUI

// MARK: - Add Holding Sheet

struct AddHoldingSheet: View {
    var onAdded: (() -> Void)?
    private let isCardLocked: Bool

    init(preselectedCard: SearchCardResult? = nil, onAdded: (() -> Void)? = nil) {
        self.onAdded = onAdded
        self.isCardLocked = preselectedCard != nil
        _selectedCard = State(initialValue: preselectedCard)
    }

    @Environment(\.dismiss) private var dismiss

    // Form state
    @State private var searchQuery = ""
    @State private var searchResults: [SearchCardResult] = []
    @State private var selectedCard: SearchCardResult?
    @State private var isGraded: Bool = false
    @State private var selectedGrade: GradeOption = .psa10
    @State private var quantity = 1
    @State private var pricePaid = ""
    @State private var acquiredDate: Date = Date()
    @State private var venue = ""
    @State private var certNumber = ""

    private static let gradedOptions: [GradeOption] = GradeOption.allCases.filter { $0 != .raw }

    @State private var isSearching = false
    @State private var isSaving = false
    @State private var saveError: String?
    @FocusState private var searchFocused: Bool

    private var isValid: Bool {
        // Price paid is optional — users can add cards they owned for
        // years without remembering the purchase price. Only validate
        // format when they actually typed something.
        let priceOk: Bool
        let trimmed = pricePaid.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            priceOk = true
        } else if let parsed = Double(trimmed), parsed >= 0 {
            priceOk = true
        } else {
            priceOk = false
        }
        return selectedCard != nil && quantity >= 1 && priceOk
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 20) {
                        cardSearchSection
                        if selectedCard != nil {
                            gradeSection
                            quantitySection
                            priceSection
                            dateSection
                            venueSection
                            if isGraded {
                                certSection
                            }
                        }

                        if let error = saveError {
                            Text(error)
                                .font(PA.Typography.caption)
                                .foregroundStyle(PA.Colors.negative)
                        }
                    }
                    .padding(PA.Layout.sectionPadding)
                    .padding(.bottom, 100)
                }
            }
            .navigationTitle("Add to Collection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(PA.Colors.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(PA.Colors.muted)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await saveHolding() }
                    } label: {
                        if isSaving {
                            ProgressView().tint(PA.Colors.accent).scaleEffect(0.8)
                        } else {
                            Text("Add")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(isValid ? PA.Colors.accent : PA.Colors.muted)
                        }
                    }
                    .disabled(!isValid || isSaving)
                }
            }
        }
    }

    // MARK: - Card Search

    private var cardSearchSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Card")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            if let card = selectedCard {
                selectedCardRow(card)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14))
                        .foregroundStyle(PA.Colors.muted)

                    TextField("Search for a card...", text: $searchQuery)
                        .font(.system(size: 15))
                        .foregroundStyle(PA.Colors.text)
                        .focused($searchFocused)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .task(id: searchQuery) {
                    await debouncedSearch()
                }

                // Results dropdown
                if !searchResults.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(searchResults.prefix(6)) { card in
                            Button {
                                selectedCard = card
                                searchResults = []
                                searchQuery = ""
                                searchFocused = false
                            } label: {
                                SearchSuggestionCell(card: card)
                            }
                            .buttonStyle(.plain)

                            if card.id != searchResults.prefix(6).last?.id {
                                Divider().background(PA.Colors.border)
                            }
                        }
                    }
                    .glassSurface(radius: 12)
                }
            }
        }
    }

    private func selectedCardRow(_ card: SearchCardResult) -> some View {
        HStack(spacing: 12) {
            if let url = card.imageURL {
                LazyImage(url: url) { state in
                    if let img = state.image {
                        img.resizable().aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        RoundedRectangle(cornerRadius: 6).fill(PA.Colors.surfaceSoft)
                    }
                }
                .frame(width: 40, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(card.canonicalName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                if let set = card.setName {
                    Text(set)
                        .font(PA.Typography.caption)
                        .foregroundStyle(PA.Colors.muted)
                }
            }

            Spacer()

            if !isCardLocked {
                Button {
                    selectedCard = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
        }
        .padding(12)
        .glassSurface(radius: 12)
    }

    // MARK: - Grade

    private var gradeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Condition")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            HStack(spacing: 8) {
                conditionPill(title: "Raw", selected: !isGraded) {
                    PAHaptics.selection()
                    isGraded = false
                    selectedGrade = .raw
                }
                conditionPill(title: "Graded", selected: isGraded) {
                    PAHaptics.selection()
                    isGraded = true
                    if selectedGrade == .raw {
                        selectedGrade = .psa10
                    }
                }
            }

            if isGraded {
                Picker("Grade", selection: $selectedGrade) {
                    ForEach(Self.gradedOptions) { grade in
                        Text(grade.rawValue)
                            .foregroundStyle(PA.Colors.text)
                            .tag(grade)
                    }
                }
                .pickerStyle(.wheel)
                .frame(height: 120)
                .clipped()
                .onChange(of: selectedGrade) { _, _ in PAHaptics.selection() }
                .padding(.horizontal, 12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .colorScheme(.dark)
            }
        }
    }

    private func conditionPill(title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(selected ? PA.Colors.background : PA.Colors.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(selected ? PA.Colors.accent : PA.Colors.surfaceSoft)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Quantity

    private var quantitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Quantity")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            HStack(spacing: 16) {
                Button { if quantity > 1 { quantity -= 1 } } label: {
                    Image(systemName: "minus.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(quantity > 1 ? PA.Colors.accent : PA.Colors.muted)
                }

                Text("\(quantity)")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                    .frame(width: 40)

                Button { quantity += 1 } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(PA.Colors.accent)
                }
            }
            .padding(12)
            .glassSurface(radius: 12)
        }
    }

    // MARK: - Price

    private var priceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Price Paid (per card)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                Text("· optional")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.muted.opacity(0.7))
            }

            HStack(spacing: 8) {
                Text("$")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)

                TextField("0.00", text: $pricePaid)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(PA.Colors.text)
                    .keyboardType(.decimalPad)
            }
            .padding(12)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("Leave blank if you don't remember. You can add it later.")
                .font(.system(size: 11))
                .foregroundStyle(PA.Colors.muted)
        }
    }

    // MARK: - Date

    private var dateSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Date Acquired")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            DatePicker(
                "",
                selection: $acquiredDate,
                in: ...Date(),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .labelsHidden()
            .tint(PA.Colors.accent)
            .colorScheme(.dark)
            .padding(12)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Venue

    private var venueSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Where purchased (optional)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            TextField("e.g. eBay, LCS, Trade", text: $venue)
                .font(.system(size: 15))
                .foregroundStyle(PA.Colors.text)
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Cert Number

    private var certSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PSA/CGC Cert # (optional)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            TextField("e.g. 12345678", text: $certNumber)
                .font(.system(size: 15, design: .monospaced))
                .foregroundStyle(PA.Colors.text)
                .keyboardType(.numberPad)
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Actions

    private func debouncedSearch() async {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { searchResults = []; return }
        try? await Task.sleep(for: .milliseconds(240))
        guard !Task.isCancelled else { return }
        do {
            searchResults = try await SearchService.shared.search(query: q)
        } catch {
            searchResults = []
        }
    }

    private func saveHolding() async {
        guard let card = selectedCard else { return }

        // Price paid is optional. Empty string → nil (server stores
        // NULL). Bad input bails silently — isValid already prevents
        // the submit button from enabling in that case.
        let trimmedPrice = pricePaid.trimmingCharacters(in: .whitespaces)
        let parsedPrice: Double?
        if trimmedPrice.isEmpty {
            parsedPrice = nil
        } else if let p = Double(trimmedPrice), p >= 0 {
            parsedPrice = p
        } else {
            return
        }

        isSaving = true
        saveError = nil

        let dateStr = formatDate(acquiredDate)
        let certToSend: String? = (isGraded && !certNumber.isEmpty) ? certNumber : nil

        do {
            try await HoldingsService.shared.addHolding(
                canonicalSlug: card.canonicalSlug,
                grade: selectedGrade.rawValue,
                qty: quantity,
                pricePaidUsd: parsedPrice,
                acquiredOn: dateStr,
                venue: venue.isEmpty ? nil : venue,
                certNumber: certToSend
            )
            PAHaptics.success()
            onAdded?()
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
        isSaving = false
    }

    private func formatDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}
