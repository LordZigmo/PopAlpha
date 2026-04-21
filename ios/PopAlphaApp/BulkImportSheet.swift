import SwiftUI
import UniformTypeIdentifiers
import NukeUI

// MARK: - Bulk CSV Import
//
// Two-step sheet flow:
//
//   1. BulkImportSheet      — paste CSV into a TextEditor, or pick a
//                             `.csv` file from iCloud/Files. Parse on
//                             "Next" → push preview.
//   2. BulkImportPreviewView — show every parsed row with its
//                             resolved-card preview (via SearchService).
//                             Uncheck rows to skip, tap "Import N cards"
//                             to POST /api/holdings/bulk-import.
//
// Hard cap: 500 rows per import (server enforces too). Each row =
// one lot; duplicates (same slug + grade) insert as separate lots,
// matching manual-add semantics.

// MARK: - Parsed row model

struct BulkImportRow: Identifiable {
    let id = UUID()
    let lineNumber: Int

    // Original CSV values (for display + re-resolution)
    let name: String
    let set: String
    let number: String
    let qty: Int
    let grade: String
    let pricePaidUsd: Double?
    let acquiredDate: String?  // "yyyy-MM-dd" or nil

    // Mutable: filled in by SearchService during preview
    var resolved: SearchCardResult?
    var resolutionState: ResolutionState = .pending
    var isIncluded: Bool = true

    enum ResolutionState: Equatable {
        case pending
        case resolving
        case resolved
        case failed(String)
    }
}

// MARK: - CSV Parser
//
// Minimal RFC-4180-ish parser: commas separate fields, double quotes
// wrap fields that contain commas or newlines, "" escapes a literal
// quote inside a quoted field. Lines that are blank or start with #
// are skipped. An optional header line (first line matches expected
// column names) is auto-detected and dropped.

enum CSVParser {
    /// Expected column order. Matches the documented format.
    static let expectedColumns = ["name", "set", "number", "qty", "grade", "price", "date"]

    struct ParseResult {
        var rows: [BulkImportRow] = []
        var errors: [String] = []
    }

    static func parse(_ text: String, capRows: Int = 500) -> ParseResult {
        var result = ParseResult()
        let allLines = splitLines(text)

        // Detect + drop header row. Match is lenient: if the first
        // non-blank line's first 3 fields look like "name","set","number"
        // (any casing), treat it as a header.
        let rawLines = dropHeaderIfPresent(allLines)

        for (displayIndex, rawLine) in rawLines.enumerated() {
            let lineNumber = displayIndex + 1
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }

            let fields = parseLine(rawLine)
            if fields.count < 5 {
                result.errors.append("Line \(lineNumber): expected at least 5 fields (name, set, number, qty, grade), got \(fields.count).")
                continue
            }

            let name = fields[0].trimmingCharacters(in: .whitespaces)
            let set = fields[1].trimmingCharacters(in: .whitespaces)
            let number = fields[2].trimmingCharacters(in: .whitespaces)
            let qtyRaw = fields[3].trimmingCharacters(in: .whitespaces)
            let grade = fields[4].trimmingCharacters(in: .whitespaces)
            let priceRaw = fields.count > 5 ? fields[5].trimmingCharacters(in: .whitespaces) : ""
            let dateRaw = fields.count > 6 ? fields[6].trimmingCharacters(in: .whitespaces) : ""

            if name.isEmpty {
                result.errors.append("Line \(lineNumber): name is required.")
                continue
            }
            guard let qty = Int(qtyRaw), qty >= 1 else {
                result.errors.append("Line \(lineNumber): qty must be a positive integer (got \"\(qtyRaw)\").")
                continue
            }
            if grade.isEmpty {
                result.errors.append("Line \(lineNumber): grade is required (use RAW, PSA 10, CGC 9.5, etc).")
                continue
            }

            var pricePaid: Double? = nil
            if !priceRaw.isEmpty {
                guard let parsed = Double(priceRaw), parsed >= 0 else {
                    result.errors.append("Line \(lineNumber): price must be a non-negative number (got \"\(priceRaw)\").")
                    continue
                }
                pricePaid = parsed
            }

            let acquired: String? = dateRaw.isEmpty ? nil : dateRaw

            result.rows.append(BulkImportRow(
                lineNumber: lineNumber,
                name: name,
                set: set,
                number: number,
                qty: qty,
                grade: grade,
                pricePaidUsd: pricePaid,
                acquiredDate: acquired,
            ))

            if result.rows.count >= capRows {
                result.errors.append("Reached the \(capRows)-row cap. Split the rest into another import.")
                break
            }
        }

        return result
    }

    // MARK: Line handling

    private static func splitLines(_ text: String) -> [String] {
        // Normalize CRLF / CR → LF before splitting.
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        return normalized.components(separatedBy: "\n")
    }

    private static func dropHeaderIfPresent(_ lines: [String]) -> [String] {
        guard let first = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            return lines
        }
        let fields = parseLine(first).prefix(3).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        let looksLikeHeader =
            fields.count == 3 &&
            (fields[0] == "name" || fields[0] == "card name" || fields[0] == "card") &&
            (fields[1] == "set" || fields[1] == "set name") &&
            (fields[2] == "number" || fields[2] == "card number" || fields[2] == "no" || fields[2] == "#")
        guard looksLikeHeader else { return lines }
        // Drop the first non-blank line.
        var out = lines
        if let idx = out.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            out.remove(at: idx)
        }
        return out
    }

    /// Split a line into fields, honoring "" quoting rules.
    private static func parseLine(_ line: String) -> [String] {
        var fields: [String] = []
        var current = ""
        var inQuotes = false
        var i = line.startIndex
        while i < line.endIndex {
            let c = line[i]
            if inQuotes {
                if c == "\"" {
                    let next = line.index(after: i)
                    if next < line.endIndex, line[next] == "\"" {
                        // Escaped quote inside a quoted field.
                        current.append("\"")
                        i = next
                    } else {
                        inQuotes = false
                    }
                } else {
                    current.append(c)
                }
            } else {
                if c == "," {
                    fields.append(current)
                    current = ""
                } else if c == "\"" && current.isEmpty {
                    inQuotes = true
                } else {
                    current.append(c)
                }
            }
            i = line.index(after: i)
        }
        fields.append(current)
        return fields
    }
}

// MARK: - Entry sheet

struct BulkImportSheet: View {
    var onImported: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .paste
    @State private var pasteText: String = ""
    @State private var showFileImporter = false
    @State private var parseResult: CSVParser.ParseResult?
    @State private var fileReadError: String?
    @State private var goToPreview = false

    enum Mode: String, CaseIterable, Identifiable {
        case paste = "Paste"
        case file = "File"
        var id: String { rawValue }
    }

    private var parsedRows: [BulkImportRow] { parseResult?.rows ?? [] }
    private var parseErrors: [String] { parseResult?.errors ?? [] }

    var body: some View {
        NavigationStack {
            ZStack {
                PA.Colors.background.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        modePicker
                        inputSection
                        formatHint

                        if let fileReadError {
                            errorBanner(fileReadError)
                        }
                        if let parseResult {
                            summaryCard(parseResult)
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Import CSV")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(PA.Colors.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(PA.Colors.textSecondary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Next") {
                        goToPreview = true
                    }
                    .disabled(parsedRows.isEmpty)
                    .foregroundStyle(parsedRows.isEmpty ? PA.Colors.muted : PA.Colors.accent)
                    .fontWeight(.semibold)
                }
            }
            .navigationDestination(isPresented: $goToPreview) {
                BulkImportPreviewView(
                    initialRows: parsedRows,
                    onImported: {
                        onImported?()
                        dismiss()
                    }
                )
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.commaSeparatedText, .plainText],
                allowsMultipleSelection: false,
            ) { result in
                handleFileImport(result)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("BULK IMPORT")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.accent)
            Text("Add lots of cards at once")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(PA.Colors.text)
            Text("Paste CSV or pick a file. Max \(500) cards per import.")
                .font(.system(size: 12))
                .foregroundStyle(PA.Colors.textSecondary)
        }
    }

    // MARK: - Mode picker

    private var modePicker: some View {
        Picker("Mode", selection: $mode) {
            ForEach(Mode.allCases) { m in
                Text(m.rawValue).tag(m)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Input section

    @ViewBuilder
    private var inputSection: some View {
        switch mode {
        case .paste:
            VStack(alignment: .leading, spacing: 8) {
                Text("CSV text")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.muted)
                TextEditor(text: $pasteText)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(PA.Colors.text)
                    .frame(minHeight: 180)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .background(PA.Colors.surfaceSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                Button {
                    parseResult = CSVParser.parse(pasteText)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "wand.and.rays")
                        Text("Parse")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                }
                .disabled(pasteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        case .file:
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    showFileImporter = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text")
                        Text("Choose CSV file…")
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PA.Colors.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(PA.Colors.accent)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)

                Text("Picker opens your Files / iCloud Drive. Select a `.csv` file matching the format below.")
                    .font(.system(size: 11))
                    .foregroundStyle(PA.Colors.muted)
            }
        }
    }

    // MARK: - Format hint

    private var formatHint: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("FORMAT")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.muted)
            Text("name, set, number, qty, grade, price, date")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(PA.Colors.text)
            Text("Charizard, Base Set, 4, 1, PSA 10, 480.00, 2023-06-14")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(PA.Colors.textSecondary)
            Text("Blastoise, Base Set, 2, 2, RAW, , ")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(PA.Colors.textSecondary)
            Text("Price and date are optional; leave blank for unknown.")
                .font(.system(size: 11))
                .foregroundStyle(PA.Colors.muted)
                .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PA.Colors.surfaceSoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - Parse-summary card

    private func summaryCard(_ result: CSVParser.ParseResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: result.rows.isEmpty ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(result.rows.isEmpty ? PA.Colors.negative : PA.Colors.positive)
                Text(result.rows.isEmpty
                     ? "No valid rows"
                     : "\(result.rows.count) row\(result.rows.count == 1 ? "" : "s") ready")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
            }
            if !result.errors.isEmpty {
                ForEach(Array(result.errors.prefix(6).enumerated()), id: \.offset) { _, err in
                    Text("· \(err)")
                        .font(.system(size: 11))
                        .foregroundStyle(PA.Colors.muted)
                        .lineLimit(2)
                }
                if result.errors.count > 6 {
                    Text("+ \(result.errors.count - 6) more")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(radius: 12)
    }

    private func errorBanner(_ message: String) -> some View {
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

    // MARK: - File import

    private func handleFileImport(_ result: Result<[URL], Error>) {
        fileReadError = nil
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            // Coordinate access for iCloud-backed files.
            let didAccess = url.startAccessingSecurityScopedResource()
            defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
            do {
                let raw = try String(contentsOf: url, encoding: .utf8)
                pasteText = raw     // surface in the text editor too
                parseResult = CSVParser.parse(raw)
            } catch {
                fileReadError = "Couldn't read file: \(error.localizedDescription)"
            }
        case .failure(let err):
            fileReadError = err.localizedDescription
        }
    }
}

// MARK: - Preview sheet (resolution + commit)

struct BulkImportPreviewView: View {
    let initialRows: [BulkImportRow]
    var onImported: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var rows: [BulkImportRow]
    @State private var isImporting = false
    @State private var importError: String?

    init(initialRows: [BulkImportRow], onImported: @escaping () -> Void) {
        self.initialRows = initialRows
        self.onImported = onImported
        _rows = State(initialValue: initialRows)
    }

    // Derived counts
    private var readyCount: Int {
        rows.filter { $0.isIncluded && $0.resolutionState == .resolved }.count
    }
    private var resolvingCount: Int {
        rows.filter { r in
            if case .resolving = r.resolutionState { return true }
            if case .pending = r.resolutionState { return true }
            return false
        }.count
    }
    private var failedCount: Int {
        rows.filter { r in
            if case .failed = r.resolutionState { return true }
            return false
        }.count
    }

    var body: some View {
        ZStack {
            PA.Colors.background.ignoresSafeArea()

            ScrollView {
                LazyVStack(spacing: 10) {
                    progressCard
                    ForEach($rows) { $row in
                        rowCard($row)
                    }

                    if let importError {
                        Text(importError)
                            .font(.system(size: 12))
                            .foregroundStyle(PA.Colors.negative)
                            .padding(.top, 6)
                    }
                }
                .padding(20)
                .padding(.bottom, 100)
            }

            // Sticky commit footer
            VStack {
                Spacer()
                commitBar
            }
        }
        .navigationTitle("Review & Import")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PA.Colors.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await resolveAll()
        }
    }

    // MARK: - Progress

    private var progressCard: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .stroke(PA.Colors.borderLight, lineWidth: 2)
                    .frame(width: 28, height: 28)
                Circle()
                    .trim(from: 0, to: progressFraction)
                    .stroke(PA.Colors.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 28, height: 28)
                    .animation(.easeInOut(duration: 0.2), value: progressFraction)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(resolvingCount > 0
                     ? "Resolving \(readyCount)/\(rows.count) cards…"
                     : "Resolved \(readyCount) of \(rows.count)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                if failedCount > 0 {
                    Text("\(failedCount) couldn't be matched — skip or fix in the list below.")
                        .font(.system(size: 11))
                        .foregroundStyle(PA.Colors.muted)
                }
            }

            Spacer()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(radius: 12)
    }

    private var progressFraction: Double {
        guard !rows.isEmpty else { return 0 }
        let done = rows.filter { r in
            if case .resolved = r.resolutionState { return true }
            if case .failed = r.resolutionState { return true }
            return false
        }.count
        return Double(done) / Double(rows.count)
    }

    // MARK: - Per-row card

    @ViewBuilder
    private func rowCard(_ row: Binding<BulkImportRow>) -> some View {
        let r = row.wrappedValue
        let tappable = r.resolutionState == .resolved
        HStack(alignment: .top, spacing: 10) {
            // Include toggle
            Button {
                row.wrappedValue.isIncluded.toggle()
            } label: {
                Image(systemName: r.isIncluded ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(r.isIncluded ? PA.Colors.accent : PA.Colors.muted)
            }
            .buttonStyle(.plain)
            .disabled(!tappable)

            // Thumbnail (resolved)
            thumbnail(for: r)
                .frame(width: 36, height: 50)

            // Labels
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(r.resolved?.canonicalName ?? r.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .lineLimit(1)
                    Text("×\(r.qty)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(PA.Colors.muted)
                }
                Text(subtitle(for: r))
                    .font(.system(size: 11))
                    .foregroundStyle(PA.Colors.muted)
                    .lineLimit(1)
                stateChip(for: r)
            }

            Spacer()
        }
        .padding(10)
        .background(
            r.isIncluded && tappable
                ? PA.Colors.surfaceSoft
                : PA.Colors.surfaceSoft.opacity(0.4)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .opacity(r.isIncluded ? 1.0 : 0.55)
    }

    @ViewBuilder
    private func thumbnail(for row: BulkImportRow) -> some View {
        if let url = row.resolved?.imageURL {
            LazyImage(url: url) { state in
                if let image = state.image {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Color(PA.Colors.surfaceSoft)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
        }
    }

    private func subtitle(for row: BulkImportRow) -> String {
        if let resolved = row.resolved {
            let parts = [resolved.setName, resolved.cardNumber.map { "#\($0)" }].compactMap { $0 }
            return parts.isEmpty ? "\(row.grade)" : "\(parts.joined(separator: " · ")) · \(row.grade)"
        }
        let parts = [row.set, row.number.isEmpty ? nil : "#\(row.number)"].compactMap { $0 }
        return parts.isEmpty ? "\(row.grade)" : "\(parts.joined(separator: " · ")) · \(row.grade)"
    }

    @ViewBuilder
    private func stateChip(for row: BulkImportRow) -> some View {
        switch row.resolutionState {
        case .pending, .resolving:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini).tint(PA.Colors.muted)
                Text("Resolving…")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(PA.Colors.muted)
            }
        case .resolved:
            HStack(spacing: 4) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(PA.Colors.positive)
                Text("Matched")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.positive)
            }
        case .failed(let msg):
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(PA.Colors.negative)
                Text(msg)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.negative)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - Commit bar

    private var commitBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(readyCount) ready to import")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                if failedCount > 0 {
                    Text("\(failedCount) skipped")
                        .font(.system(size: 11))
                        .foregroundStyle(PA.Colors.muted)
                }
            }
            Spacer()
            Button {
                Task { await commit() }
            } label: {
                HStack(spacing: 6) {
                    if isImporting {
                        ProgressView().tint(PA.Colors.background).controlSize(.small)
                    }
                    Text(isImporting ? "Importing…" : "Import \(readyCount)")
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PA.Colors.background)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(readyCount > 0 ? PA.Colors.accent : PA.Colors.muted)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(readyCount == 0 || isImporting)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(PA.Colors.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(PA.Colors.border)
                .frame(height: 0.5)
        }
    }

    // MARK: - Resolution

    /// Fan out SearchService calls with a concurrency cap so we don't
    /// flood the search endpoint on large imports. Updates rows in place
    /// as results land — UI re-renders per-row as soon as each one
    /// resolves instead of waiting for the whole batch.
    private func resolveAll() async {
        let limit = 6  // concurrent lookups
        await withTaskGroup(of: (Int, BulkImportRow.ResolutionState, SearchCardResult?).self) { group in
            var inFlight = 0
            var nextIndex = 0

            func dispatch() {
                while inFlight < limit && nextIndex < rows.count {
                    let i = nextIndex
                    nextIndex += 1
                    let row = rows[i]
                    inFlight += 1
                    group.addTask {
                        let result = await resolveOne(row)
                        return (i, result.state, result.card)
                    }
                }
            }

            dispatch()
            for await (idx, state, card) in group {
                inFlight -= 1
                await MainActor.run {
                    if rows.indices.contains(idx) {
                        rows[idx].resolutionState = state
                        rows[idx].resolved = card
                        // If resolution failed, default to un-included
                        // so user doesn't have to manually uncheck each.
                        if case .failed = state {
                            rows[idx].isIncluded = false
                        }
                    }
                }
                dispatch()
            }
        }
    }

    private func resolveOne(_ row: BulkImportRow) async -> (state: BulkImportRow.ResolutionState, card: SearchCardResult?) {
        // Build a search query from the CSV columns. Including the set
        // and number dramatically improves match accuracy; name alone
        // produces too many false positives across reprints.
        var terms: [String] = [row.name]
        if !row.set.isEmpty { terms.append(row.set) }
        let query = terms.joined(separator: " ")

        do {
            let results = try await SearchService.shared.search(query: query)
            guard !results.isEmpty else {
                return (.failed("No match"), nil)
            }
            // Pick best match: prefer same cardNumber, then same setName
            // (case-insensitive), then the top-ranked result from search.
            let numberMatch = results.first { r in
                guard let rn = r.cardNumber, !row.number.isEmpty else { return false }
                return rn.compare(row.number, options: .caseInsensitive) == .orderedSame
            }
            if let numberMatch { return (.resolved, numberMatch) }

            let setMatch = results.first { r in
                guard let rs = r.setName, !row.set.isEmpty else { return false }
                return rs.compare(row.set, options: .caseInsensitive) == .orderedSame
            }
            if let setMatch { return (.resolved, setMatch) }

            return (.resolved, results[0])
        } catch {
            return (.failed("Search error"), nil)
        }
    }

    // MARK: - Commit

    private func commit() async {
        importError = nil
        isImporting = true
        defer { isImporting = false }

        let payload = rows
            .filter { $0.isIncluded && $0.resolutionState == .resolved }
            .compactMap { r -> [String: Any]? in
                guard let resolved = r.resolved else { return nil }
                var row: [String: Any] = [
                    "canonical_slug": resolved.canonicalSlug,
                    "grade": r.grade,
                    "qty": r.qty,
                ]
                if let price = r.pricePaidUsd { row["price_paid_usd"] = price }
                if let date = r.acquiredDate { row["acquired_on"] = date }
                return row
            }

        guard !payload.isEmpty else { return }

        do {
            let response: BulkImportResponse = try await APIClient.post(
                path: "/api/holdings/bulk-import",
                body: ["rows": payload]
            )
            if response.ok {
                PAHaptics.tap()
                onImported()
            } else {
                importError = response.error ?? "Import failed"
            }
        } catch {
            importError = error.localizedDescription
        }
    }
}

// MARK: - Response

private struct BulkImportResponse: Decodable {
    let ok: Bool
    let inserted: Int?
    let error: String?
}
