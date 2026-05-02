// OfflineSmokeReportSheet.swift
//
// DEBUG-only presentation sheet for OfflineScannerSmokeTest results.
// Shows the three-tier validation outcome (catalog/embedder/kNN)
// in a monospaced layout matching the report's `summary` text — easy
// to read at a glance and easy to share via screenshot when triaging
// real-device issues.
//
// Sits next to ScannerTabView because that's where the trigger button
// lives; could move to a Debug/ folder if more debug surfaces land.

#if DEBUG
import SwiftUI
import PopAlphaCore

struct OfflineSmokeReportSheet: View {
    let report: OfflineScannerSmokeReport
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    summaryBadge
                    pathSection
                    checksSection
                    actionSection
                }
                .padding(20)
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Offline Smoke Test")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Sections

    private var summaryBadge: some View {
        HStack(spacing: 10) {
            Image(systemName: report.allPassed ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(report.allPassed ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(report.allPassed ? "All checks passed" : "Some checks failed")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                Text("\(report.checks.filter { $0.passed }.count)/\(report.checks.count) green")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.6))
            }
            Spacer()
        }
        .padding(14)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var pathSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Resources")
            keyValueRow("catalog", report.catalogPath)
            keyValueRow("model", report.modelPath)
        }
    }

    private var checksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Checks")
            ForEach(Array(report.checks.enumerated()), id: \.offset) { _, check in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(check.passed ? Color.green : Color.red)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(check.name)
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.white)
                            Text(String(format: "%.1fms", check.elapsedMs))
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.5))
                        }
                        Text(check.detail)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.75))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.white.opacity(check.passed ? 0.03 : 0.06))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    private var actionSection: some View {
        VStack(spacing: 8) {
            Button {
                UIPasteboard.general.string = report.summary
            } label: {
                Label("Copy report to clipboard", systemImage: "doc.on.doc")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 6)
    }

    // MARK: - Helpers

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .heavy))
            .tracking(1.5)
            .foregroundStyle(.white.opacity(0.5))
    }

    private func keyValueRow(_ key: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(key)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
                .frame(width: 60, alignment: .leading)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(3)
                .truncationMode(.middle)
        }
    }
}
#endif
