import SwiftUI

// MARK: - AI Brief Detail View
//
// Destination for the "Read more" button on the homepage AI Brief card.
// Shows the full brief — untruncated summary, takeaway, the reader's
// style lens, focus set, and provenance metadata (model + freshness).
//
// Deliberately read-only and compact. The home card already surfaces
// the essentials; this view's job is simply to let a curious collector
// "go deeper" without swallowing the screen.

struct AIBriefDetailView: View {
    let brief: HomepageAIBriefDTO?
    let fallbackAsOf: String?
    let styleLabel: String?

    private static let placeholderSummary = "Your AI market brief will appear here once today's data is in. It summarizes where strength is concentrating and which sets are leading the board."
    private static let placeholderTakeaway = "Updating shortly"

    private var summary: String { brief?.summary ?? Self.placeholderSummary }
    private var takeaway: String { brief?.takeaway ?? Self.placeholderTakeaway }
    private var isLive: Bool { brief != nil && brief?.source != "fallback" }
    private var mattersLine: String {
        "Matters most for: \(styleLabel ?? "Modern collectors")"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Hero card mirrors the home card's visual language
                heroCard
                    .padding(.horizontal, PA.Layout.sectionPadding)

                // Metadata grid — model, freshness, source
                metadataCard
                    .padding(.horizontal, PA.Layout.sectionPadding)

                // Tip / disclaimer
                Text("Briefs are generated hourly from PopAlpha's price, supply, and demand signals. They summarize — they don't predict. Always DYOR before acting.")
                    .font(.system(size: 11))
                    .foregroundStyle(PA.Colors.muted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, PA.Layout.sectionPadding)
                    .padding(.top, 8)
            }
            .padding(.vertical, 16)
        }
        .background(PA.Colors.background)
        .navigationTitle("AI Brief")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Hero card

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Eyebrow row
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(PA.Colors.accent)
                    Text("AI BRIEF")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(2.0)
                        .foregroundStyle(PA.Colors.accent)
                }
                Circle()
                    .fill(isLive ? PA.Colors.positive : PA.Colors.muted)
                    .frame(width: 5, height: 5)
                Text(isLive ? "LIVE" : "CACHED")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(isLive ? PA.Colors.positive : PA.Colors.muted)
                Spacer()
            }

            // Full, untruncated summary
            Text(summary)
                .font(.system(size: 16))
                .foregroundStyle(PA.Colors.text)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            Divider().background(PA.Colors.border)

            // Takeaway block
            VStack(alignment: .leading, spacing: 8) {
                Text("TAKEAWAY")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.5)
                    .foregroundStyle(PA.Colors.muted)
                HStack(alignment: .top, spacing: 8) {
                    Text("🔥")
                        .font(.system(size: 15))
                    Text(takeaway)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PA.Colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Who this matters to
            HStack(spacing: 6) {
                Image(systemName: "scope")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PA.Colors.accent)
                Text(mattersLine)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.textSecondary)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                PA.Gradients.cardSurface
                RadialGradient(
                    colors: [PA.Colors.accent.opacity(0.14), .clear],
                    center: .topLeading,
                    startRadius: 0,
                    endRadius: 260
                )
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.panelRadius, style: .continuous)
                .stroke(PA.Colors.accent.opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Metadata card

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("HOW THIS WAS BUILT")
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.5)
                .foregroundStyle(PA.Colors.muted)

            metaRow(
                label: "Model",
                value: brief?.modelLabel ?? "PopAlpha mix"
            )
            if let focus = brief?.focusSet, !focus.isEmpty {
                metaRow(label: "Focus set", value: focus)
            }
            metaRow(label: "Source", value: (brief?.source ?? "fallback").capitalized)
            metaRow(label: "Data as of", value: dataAsOfLabel)
            metaRow(label: "Generated", value: generatedAtLabel)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PA.Gradients.cardSurface)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous)
                .stroke(PA.Colors.borderLight, lineWidth: 1)
        )
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
                .frame(width: 92, alignment: .leading)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Formatters

    private var dataAsOfLabel: String {
        formatRelativeOrAbsolute(brief?.dataAsOf ?? fallbackAsOf) ?? "—"
    }

    private var generatedAtLabel: String {
        formatRelativeOrAbsolute(brief?.generatedAt ?? fallbackAsOf) ?? "—"
    }

    private func formatRelativeOrAbsolute(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let minutes = Int(-date.timeIntervalSinceNow / 60)
        if minutes < 60 {
            return "\(max(1, minutes))m ago"
        }
        let df = DateFormatter()
        df.dateStyle = .medium
        df.timeStyle = .short
        return df.string(from: date)
    }
}

#Preview("AI Brief Detail") {
    NavigationStack {
        AIBriefDetailView(
            brief: HomepageAIBriefDTO(
                version: "v1",
                summary: "Modern holographic Charizards are leading the board as grading caps rise and sealed Crown Zenith supply tightens. Base-set staples are flat-to-down while late-2020 sets see renewed nostalgia demand.",
                takeaway: "Graded modern holos are the tape to watch this week.",
                focusSet: "Crown Zenith",
                modelLabel: "Gemini 2.0 · PopAlpha mix",
                source: "llm",
                dataAsOf: "2026-04-17T15:00:00.000Z",
                generatedAt: "2026-04-17T15:05:00.000Z"
            ),
            fallbackAsOf: nil,
            styleLabel: "Graded PSA Collector"
        )
    }
    .preferredColorScheme(.dark)
}
