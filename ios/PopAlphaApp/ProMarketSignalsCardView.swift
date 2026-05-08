// ProMarketSignalsCardView.swift
//
// Pro-only variant-level market signals (trend / breakout / value
// reads) for a card. Mirrors the visual treatment of
// PersonalizedInsightCardView (rounded pill card with inset accent
// rail + glow shadow) but uses the cyan PA.Colors.accent palette so
// it visually distinguishes "market data" from "personalization."
//
// Behavior:
//   - Pro user: calls GET /api/pro/signals?slug=<slug>&grade=RAW via
//     APIClient.getProSignals, renders up to 3 variant readouts.
//     Empty variants array (graded buckets — they intentionally lack
//     enough history points for signals; see the note in
//     /api/pro/signals/route.ts) shows the API-supplied note text
//     instead of hiding the card.
//   - Free user: skips the API call entirely (the route 403s for
//     non-pro and we'd waste a request per card view). Renders static
//     mock readouts wrapped in LockedPreviewOverlay; tap routes to
//     PaywallView(context: .proSignals).

import OSLog
import SwiftUI

struct ProMarketSignalsCardView: View {
    let canonicalSlug: String
    let variantRef: String?

    @StateObject private var gate = PremiumGate.shared
    @State private var loading = true
    @State private var response: APIClient.ProSignalsResponse?
    @State private var loadError: String?
    @State private var showPaywall = false

    private static let accent = PA.Colors.accent
    private static let accentSoft = PA.Colors.accent.opacity(0.12)
    private static let accentBorder = PA.Colors.accent.opacity(0.35)
    private static let accentText = Color(red: 0.85, green: 0.96, blue: 1.0)
    private static let accentMuted = Color(red: 0.75, green: 0.92, blue: 1.0)
    private static let accentHeading = Color(red: 0.65, green: 0.86, blue: 0.97)

    var body: some View {
        if gate.isPro {
            proContent
                .task(id: taskKey) { await load() }
        } else {
            freeTeaser
        }
    }

    private var taskKey: String { "\(canonicalSlug)|\(variantRef ?? "")" }

    // MARK: - Pro user content

    @ViewBuilder
    private var proContent: some View {
        // Hide entirely on auth/server failure so a free→pro upgrade
        // doesn't leave a broken empty card lingering. Errors visible
        // in Logger.api.
        if let response, response.ok {
            cardShell {
                header(showProBadge: false)

                if let variants = response.variants, !variants.isEmpty {
                    variantList(Array(variants.prefix(3)))
                } else if let note = response.note, !note.isEmpty {
                    noteText(note)
                } else {
                    noteText("No variant signals available for this card yet.")
                }
            }
        } else if loading {
            cardShell {
                header(showProBadge: false)
                Text("Loading market signals…")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Self.accentMuted.opacity(0.7))
            }
        } else if let loadError {
            // Quiet failure — log + collapse. The user already has Pro;
            // they don't need a red error block on every card detail.
            EmptyView()
                .onAppear { Logger.api.warning("[pro-signals] \(loadError)") }
        } else {
            EmptyView()
        }
    }

    // MARK: - Free teaser

    private var freeTeaser: some View {
        cardShell {
            header(showProBadge: true)

            LockedPreviewOverlay(
                ctaText: "Unlock Pro signals",
                blurRadius: 5,
                onTap: { showPaywall = true },
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    teaserRow(label: "Holographic", trend: 0.62, breakout: 0.41, value: 0.78)
                    teaserRow(label: "1st Edition", trend: 0.48, breakout: 0.55, value: 0.69)
                    teaserRow(label: "Reverse Holo", trend: 0.31, breakout: 0.22, value: 0.83)
                }
            }
        }
        .sheet(isPresented: $showPaywall) {
            PaywallView(context: .proSignals)
        }
    }

    // MARK: - Card shell + header

    @ViewBuilder
    private func cardShell<Inner: View>(@ViewBuilder content: () -> Inner) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.accentSoft)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(alignment: .leading) {
            // Inset accent rail — same trick PersonalizedInsightCardView
            // uses; sits inside the rounded corners.
            Capsule()
                .fill(Self.accent)
                .frame(width: 3)
                .padding(.vertical, 10)
                .padding(.leading, 2)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Self.accentBorder, lineWidth: 1)
        )
        .shadow(color: Self.accent.opacity(0.22), radius: 14, x: 0, y: 0)
        .shadow(color: .black.opacity(0.24), radius: 30, x: 0, y: 18)
    }

    private func header(showProBadge: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Self.accentMuted)
                    Text("Pro Market Signals")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Self.accentHeading)
                }
                Text("Variant-level momentum")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Self.accentMuted.opacity(0.8))
                    .tracking(0.4)
            }
            Spacer(minLength: 8)
            if showProBadge {
                Text("PRO")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(PA.Colors.gold)
                    .tracking(0.6)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(PA.Colors.gold.opacity(0.12))
                    .clipShape(Capsule())
            }
        }
    }

    // MARK: - Pro variant list

    @ViewBuilder
    private func variantList(_ variants: [APIClient.ProSignalsResponse.ProVariantSignal]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(variants.enumerated()), id: \.offset) { _, variant in
                signalRow(
                    label: prettyVariantLabel(variant.variantRef),
                    trend: variant.signalTrend,
                    breakout: variant.signalBreakout,
                    value: variant.signalValue,
                )
            }
        }
    }

    private func signalRow(label: String, trend: Double?, breakout: Double?, value: Double?) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Self.accentText)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            statChip("Trend", value: trend)
            statChip("Brk", value: breakout)
            statChip("Val", value: value)
        }
    }

    private func teaserRow(label: String, trend: Double, breakout: Double, value: Double) -> some View {
        signalRow(label: label, trend: trend, breakout: breakout, value: value)
    }

    private func statChip(_ label: String, value: Double?) -> some View {
        VStack(alignment: .center, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Self.accentMuted.opacity(0.7))
                .tracking(0.4)
            Text(value.map { String(format: "%.2f", $0) } ?? "—")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(Self.accentText)
        }
        .frame(width: 38)
        .padding(.vertical, 4)
        .background(Self.accent.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func noteText(_ note: String) -> some View {
        Text(note)
            .font(.system(size: 12))
            .foregroundStyle(Self.accentMuted.opacity(0.75))
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Helpers

    /// Variant refs come over as the long canonical-encoded string
    /// (e.g. "<slug>::HOLOGRAPHIC::RAW"). For display we just want the
    /// finish/print label — strip the slug prefix and the grade suffix.
    private func prettyVariantLabel(_ ref: String) -> String {
        let parts = ref.split(separator: "::").map(String.init)
        // Typical shape is [slug, finish/printing, grade]. If we have 3+
        // segments, the middle one is the human-readable bit. Otherwise
        // fall back to the raw string.
        if parts.count >= 3 {
            return parts[1].replacingOccurrences(of: "_", with: " ").capitalized
        }
        return ref
    }

    // MARK: - Loading

    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        do {
            let resp = try await APIClient.getProSignals(slug: canonicalSlug, grade: "RAW")
            response = resp
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }
}
