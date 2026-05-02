import SwiftUI
import OSLog

// MARK: - Edit Holding Lot Sheet
//
// Opened from PortfolioPositionCell when a user taps an individual lot
// row. Lets them retroactively add a cost basis they didn't have when
// first recording the card, bump quantity, fix grade/date, etc.
//
// Intentionally narrower than AddHoldingSheet — no card search, no
// graded-vs-raw toggle, no density metrics. Just the six user-editable
// fields, pre-filled from the existing HoldingRow, replayed server-
// side on submit.

struct EditHoldingLotSheet: View {
    let lot: HoldingRow
    /// Card display name for the header — positions know this from
    /// their SetMetadata, lots don't. Passed in so the sheet shows
    /// "Editing: Charizard" and not just an id.
    let cardName: String?
    /// Async callback fired after a successful save. The parent owns
    /// dismissal — the closure is expected to refresh data AND close
    /// the sheet (e.g. by setting its binding to nil). We deliberately
    /// don't call @Environment(\.dismiss) here on success because in
    /// some iOS versions it doesn't propagate reliably from inside a
    /// NavigationStack inside a sheet.
    var onSaved: (() async -> Void)?

    @Environment(\.dismiss) private var dismiss

    // Form state (seeded from the lot on init)
    @State private var pricePaid: String
    @State private var quantity: Int
    @State private var selectedGrade: GradeOption
    @State private var acquiredDate: Date
    @State private var hasAcquiredDate: Bool
    @State private var venue: String
    @State private var certNumber: String

    @State private var isSaving = false
    @State private var saveError: String?
    /// Tracks focus on the price field so we can auto-clear a placeholder
    /// 0.00 the first time the user taps in — saves them from having to
    /// manually delete a value they didn't enter.
    @FocusState private var priceFieldFocused: Bool

    init(lot: HoldingRow, cardName: String?, onSaved: (() async -> Void)? = nil) {
        self.lot = lot
        self.cardName = cardName
        self.onSaved = onSaved
        _pricePaid = State(
            initialValue: lot.pricePaidUsd.map { String(format: "%.2f", $0) } ?? ""
        )
        _quantity = State(initialValue: max(1, lot.qty))
        _selectedGrade = State(initialValue: Self.gradeFromString(lot.grade))
        _acquiredDate = State(initialValue: Self.parseDate(lot.acquiredOn) ?? Date())
        _hasAcquiredDate = State(initialValue: lot.acquiredOn != nil)
        _venue = State(initialValue: lot.venue ?? "")
        _certNumber = State(initialValue: lot.certNumber ?? "")
    }

    private var isValid: Bool {
        // Price paid optional. Everything else present by construction.
        let trimmed = pricePaid.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return quantity >= 1 }
        guard let parsed = Double(trimmed), parsed >= 0 else { return false }
        _ = parsed
        return quantity >= 1
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        priceSection
                        quantitySection
                        gradeSection
                        dateSection
                        venueSection
                        if selectedGrade != .raw {
                            certSection
                        }

                        if let saveError {
                            errorCard(saveError)
                        }
                    }
                    .padding(20)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Edit Holding")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(PA.Colors.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        // Explicit MainActor so state mutations in save()
                        // can't end up on a background thread (which would
                        // not trigger SwiftUI re-renders).
                        Task { @MainActor in await save() }
                    } label: {
                        if isSaving {
                            ProgressView().tint(PA.Colors.accent)
                        } else {
                            Text("Save").fontWeight(.semibold)
                        }
                    }
                    .disabled(!isValid || isSaving)
                    .foregroundStyle(isValid && !isSaving ? PA.Colors.accent : PA.Colors.muted)
                }
            }
            .alert("Couldn't save changes", isPresented: errorAlertBinding) {
                Button("OK", role: .cancel) { saveError = nil }
            } message: {
                Text(saveError ?? "")
            }
        }
    }

    /// Bridges the optional saveError into an isPresented binding so
    /// errors surface as a modal alert no matter where the user has
    /// scrolled in the form.
    private var errorAlertBinding: Binding<Bool> {
        Binding(
            get: { saveError != nil },
            set: { if !$0 { saveError = nil } }
        )
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("EDITING")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.accent)
            Text(cardName ?? lot.canonicalSlug ?? "Holding")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(2)
        }
    }

    // MARK: - Price (optional)

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
                    .focused($priceFieldFocused)
                    .onChange(of: priceFieldFocused) { _, focused in
                        // On focus, if the current value is exactly zero
                        // (0, 0.0, 0.00, etc.), clear it so the user can
                        // type a real price without first deleting the
                        // placeholder. Non-zero values are preserved.
                        if focused,
                           let v = Double(pricePaid.trimmingCharacters(in: .whitespaces)),
                           v == 0 {
                            pricePaid = ""
                        }
                    }
            }
            .padding(12)
            .background(PA.Colors.surfaceSoft)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("Leave blank if you don't remember. Clearing a previously-entered price stores it as unknown cost basis.")
                .font(.system(size: 11))
                .foregroundStyle(PA.Colors.muted)
        }
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
                .disabled(quantity <= 1)

                Spacer()

                Text("\(quantity)")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                    .monospacedDigit()

                Spacer()

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

    // MARK: - Grade

    private var gradeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Grade")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PA.Colors.muted)

            Menu {
                ForEach(GradeOption.allCases) { g in
                    Button {
                        selectedGrade = g
                    } label: {
                        HStack {
                            Text(g.rawValue)
                            if selectedGrade == g {
                                Spacer()
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack {
                    Text(selectedGrade.rawValue)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(PA.Colors.muted)
                }
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    // MARK: - Date (optional)

    private var dateSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Date Acquired")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                Spacer()
                Toggle("", isOn: $hasAcquiredDate)
                    .labelsHidden()
                    .tint(PA.Colors.accent)
            }

            if hasAcquiredDate {
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
            } else {
                Text("Date not recorded")
                    .font(.system(size: 12))
                    .foregroundStyle(PA.Colors.muted)
                    .padding(.vertical, 4)
            }
        }
    }

    // MARK: - Venue

    private var venueSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Venue")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                Text("· optional")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.muted.opacity(0.7))
            }

            TextField("e.g. eBay, TCGplayer, LGS", text: $venue)
                .font(.system(size: 15))
                .foregroundStyle(PA.Colors.text)
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Cert number (graded only)

    private var certSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Cert Number")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                Text("· optional")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PA.Colors.muted.opacity(0.7))
            }

            TextField("PSA / CGC / BGS cert", text: $certNumber)
                .font(.system(size: 15))
                .foregroundStyle(PA.Colors.text)
                .keyboardType(.numbersAndPunctuation)
                .padding(12)
                .background(PA.Colors.surfaceSoft)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Error banner

    private func errorCard(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(PA.Colors.negative)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(PA.Colors.text)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PA.Colors.negative.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - Save

    @MainActor
    private func save() async {
        Logger.ui.debug("save() invoked for lot id=\(lot.id), grade=\(selectedGrade.rawValue), qty=\(quantity)")

        let trimmedPrice = pricePaid.trimmingCharacters(in: .whitespaces)
        let parsedPrice: Double?
        if trimmedPrice.isEmpty {
            parsedPrice = nil
        } else if let p = Double(trimmedPrice), p >= 0 {
            parsedPrice = p
        } else {
            // Don't silently return — the user tapped Save with
            // something they presumably want to commit. Surface the
            // problem so they can correct it.
            Logger.ui.debug("price parse failed: '\(trimmedPrice)'")
            saveError = "Price '\(trimmedPrice)' isn't a valid number. Clear the field or enter a number like 12.34."
            return
        }

        let dateStr: String?
        if hasAcquiredDate {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            dateStr = f.string(from: acquiredDate)
        } else {
            dateStr = nil
        }

        let certToSend: String?
        if selectedGrade == .raw {
            // RAW cards don't have cert numbers; clear whatever was there.
            certToSend = nil
        } else {
            certToSend = certNumber.trimmingCharacters(in: .whitespaces)
        }

        isSaving = true
        saveError = nil

        do {
            Logger.ui.debug("calling PATCH /api/holdings for id=\(lot.id)")
            try await HoldingsService.shared.updateHolding(
                id: lot.id,
                grade: selectedGrade.rawValue,
                qty: quantity,
                pricePaidUsd: parsedPrice,
                acquiredOn: dateStr,
                venue: venue.trimmingCharacters(in: .whitespaces),
                certNumber: certToSend
            )
            Logger.ui.debug("PATCH succeeded for id=\(lot.id)")
            isSaving = false
            PAHaptics.tap()
            // Parent owns dismissal — its onSaved closure is expected
            // to refresh state AND clear its sheet binding.
            Logger.ui.debug("invoking onSaved (refresh + close sheet)")
            await onSaved?()
            Logger.ui.debug("onSaved returned — save() complete")
        } catch {
            Logger.ui.debug("save FAILED for id=\(lot.id): \(error)")
            saveError = error.localizedDescription
            isSaving = false
        }
    }

    // MARK: - Helpers

    private static func gradeFromString(_ raw: String) -> GradeOption {
        GradeOption(rawValue: raw) ?? .raw
    }

    private static func parseDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: raw)
    }
}
