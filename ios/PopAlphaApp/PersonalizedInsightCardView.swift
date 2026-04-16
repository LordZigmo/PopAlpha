import SwiftUI

// MARK: - Personalized Insight Card
//
// Mirrors the web `<PersonalizedCardInsight />` purple pill placed directly
// below the AI Brief. Renders null when personalization is disabled or the
// request fails. Observational tone, no buy/sell language.

struct PersonalizedInsightCardView: View {
    let canonicalSlug: String
    let variantRef: String?

    @State private var loading: Bool = true
    @State private var response: PersonalizedExplanationResponse?

    private static let purpleBorder = Color(red: 0.752, green: 0.517, blue: 0.988)     // #C084FC
    private static let purpleAccent = Color(red: 0.659, green: 0.333, blue: 0.969)     // #A855F7
    private static let purpleText = Color(red: 0.961, green: 0.949, blue: 1.0)         // #F5F3FF
    private static let purpleMuted = Color(red: 0.914, green: 0.835, blue: 1.0)        // #E9D5FF
    private static let purpleHeading = Color(red: 0.847, green: 0.706, blue: 0.996)    // #D8B4FE
    private static let purpleGlow = Color(red: 0.659, green: 0.333, blue: 0.969)

    var body: some View {
        guardedContent
            .task(id: taskKey) {
                await load()
            }
    }

    private var taskKey: String {
        "\(canonicalSlug)|\(variantRef ?? "")"
    }

    @ViewBuilder
    private var guardedContent: some View {
        if response?.enabled == false {
            EmptyView()
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            TypewriterishText(
                text: summaryText,
                font: .system(size: 16, weight: .medium),
                color: Self.purpleText
            )
            .lineSpacing(3)

            if let reasons = response?.explanation?.reasons, !reasons.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(reasons.enumerated()), id: \.offset) { _, reason in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(Self.purpleBorder.opacity(0.75))
                                .frame(width: 5, height: 5)
                                .padding(.top, 7)
                            Text(reason)
                                .font(.system(size: 14, weight: .regular))
                                .foregroundStyle(Self.purpleText.opacity(0.92))
                                .lineSpacing(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            if let caveats = response?.explanation?.caveats, !caveats.isEmpty {
                Text(caveats.joined(separator: " · "))
                    .font(.system(size: 11, weight: .regular))
                    .italic()
                    .foregroundStyle(Self.purpleMuted.opacity(0.65))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.purpleAccent.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(alignment: .leading) {
            // Inset rounded rail — sits inside the rounded corners
            // rather than trying to trace them.
            Capsule()
                .fill(Self.purpleAccent)
                .frame(width: 3)
                .padding(.vertical, 10)
                .padding(.leading, 2)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Self.purpleBorder.opacity(0.35), lineWidth: 1)
        )
        .shadow(color: Self.purpleGlow.opacity(0.28), radius: 14, x: 0, y: 0)
        .shadow(color: .black.opacity(0.24), radius: 30, x: 0, y: 18)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "wand.and.stars")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Self.purpleMuted)
                    Text("How this fits your style")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Self.purpleHeading)
                }
                Text("Personalized for you")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Self.purpleMuted.opacity(0.8))
                    .tracking(0.4)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                badge
                if let pct = confidencePct {
                    Text("\(pct)% signal")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Self.purpleMuted.opacity(0.75))
                        .tracking(0.4)
                }
            }
        }
    }

    private var badge: some View {
        Text(fitsLabel)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Self.purpleText)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Self.purpleAccent.opacity(0.28))
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(Self.purpleBorder.opacity(0.45), lineWidth: 1)
            )
    }

    // MARK: - Data loading

    @MainActor
    private func load() async {
        loading = true
        let result = await PersonalizationService.shared.fetchExplanation(
            slug: canonicalSlug,
            variantRef: variantRef
        )
        response = result
        loading = false
    }

    // MARK: - Derived

    private var summaryText: String {
        if let summary = response?.explanation?.summary, !summary.isEmpty {
            return summary
        }
        if loading {
            return "Reading your activity…"
        }
        return "We’ll learn your collecting style as you browse."
    }

    private var fitsLabel: String {
        switch response?.explanation?.fits {
        case "contrast":
            return "Off pattern"
        case "aligned":
            return "Your style"
        default:
            return "Your style"
        }
    }

    private var confidencePct: Int? {
        guard let confidence = response?.profileSummary?.confidence else { return nil }
        guard response?.profileSummary?.eventCount ?? 0 > 0 else { return nil }
        return Int(round(confidence * 100))
    }
}

// MARK: - TypewriterishText
//
// Mirrors the web's typewriter feel with a lightweight opacity fade-in so the
// section doesn't feel static. Intentionally minimal — no per-character
// animation, which would be noisy on mobile.

private struct TypewriterishText: View {
    let text: String
    let font: Font
    let color: Color
    @State private var visible: Bool = false

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 4)
            .animation(.easeOut(duration: 0.35), value: visible)
            .onAppear { visible = true }
            .id(text)
    }
}
