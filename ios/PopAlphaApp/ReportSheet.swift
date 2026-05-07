import SwiftUI

// MARK: - Report Sheet
//
// Reusable sheet for reporting any UGC surface (comment, profile, post,
// activity event). Apple Guideline 1.2 requires this to be reachable
// from every UGC item the user sees.

struct ReportSheet: View {
    let targetKind: ReportTargetKind
    let targetId: String
    let targetLabel: String?
    /// If set, the report is sent via the handle-based profile-report
    /// path (server resolves handle → clerk_user_id). Used from
    /// UserProfileView which only knows the displayed user's handle.
    let profileHandle: String?

    init(
        targetKind: ReportTargetKind,
        targetId: String,
        targetLabel: String?,
        profileHandle: String? = nil,
    ) {
        self.targetKind = targetKind
        self.targetId = targetId
        self.targetLabel = targetLabel
        self.profileHandle = profileHandle
    }

    @Environment(\.dismiss) private var dismiss

    @State private var selectedReason: ReportReason?
    @State private var details: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?
    @State private var didSucceed: Bool = false

    var body: some View {
        NavigationStack {
            Form {
                if let label = targetLabel {
                    Section {
                        Text(label)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    } header: {
                        Text("Reporting")
                    }
                }

                Section {
                    ForEach(ReportReason.allCases) { reason in
                        Button {
                            selectedReason = reason
                        } label: {
                            HStack {
                                Text(reason.displayLabel)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if selectedReason == reason {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                        .accessibilityLabel(reason.displayLabel)
                    }
                } header: {
                    Text("Reason")
                }

                Section {
                    TextField("Add details (optional)", text: $details, axis: .vertical)
                        .lineLimit(3...6)
                        .accessibilityLabel("Additional details")
                } header: {
                    Text("Details")
                } footer: {
                    Text("Your report is private. Our team reviews reports within 24 hours and may remove content or restrict accounts that violate our Community Guidelines.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                if didSucceed {
                    Section {
                        Label("Report submitted. Thank you.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityLabel("Cancel report")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: submit) {
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text("Submit")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(selectedReason == nil || isSubmitting || didSucceed)
                    .accessibilityLabel("Submit report")
                }
            }
        }
    }

    private func submit() {
        guard let reason = selectedReason, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil

        Task { @MainActor in
            defer { isSubmitting = false }
            do {
                if let handle = profileHandle, targetKind == .profile {
                    try await APIClient.reportProfile(
                        handle: handle,
                        reason: reason,
                        details: details,
                    )
                } else {
                    try await APIClient.reportContent(
                        targetKind: targetKind,
                        targetId: targetId,
                        reason: reason,
                        details: details,
                    )
                }
                didSucceed = true
                try? await Task.sleep(nanoseconds: 900_000_000)
                dismiss()
            } catch APIError.httpError(_, let body) {
                errorMessage = body.isEmpty ? "Couldn't submit report." : body
            } catch {
                errorMessage = "Couldn't submit report. Please try again."
            }
        }
    }
}
