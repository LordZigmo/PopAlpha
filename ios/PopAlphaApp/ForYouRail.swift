import SwiftUI
import NukeUI

// MARK: - For You Rail
//
// Horizontal rail of personalized card tiles. Sits between AI Brief and
// Market Pulse in the homepage order. Designed as the "just one more
// tap" module — compact tiles, fast to skim, each one captioned with a
// *why* chip so the collector understands at a glance why each card is
// there for them.
//
// Data path — Phase 1 (this PR):
//   • Seed card list comes from existing HomepageSignalBoardDTO:
//       - signed-in: momentum (windowed) as a proxy for "most actionable"
//       - guest/no profile: topMovers as a globally trending fallback
//   • Per-card rationale chip fetched lazily from
//       GET /api/personalization/explanation?slug=X
//     using PersonalizationService.fetchExplanation(). Cached server-side
//     per (actor, slug, profile_version) so repeat loads are cheap.
//
// Data path — Phase 2 (follow-up, not in this PR):
//   • A dedicated /api/homepage/for-you endpoint will return a curated
//     slug list derived from the user's profile + watchlist + recently
//     viewed. This view is already shaped to consume that — only the
//     seed list in `seedCards(...)` changes.
//
// Fallback rules (never render an empty rail):
//   • No signal board data   → don't render the section at all
//   • Fewer than 2 tiles     → don't render
//   • Otherwise              → always render with whatever we have

struct ForYouRail: View {
    let signalBoard: HomepageSignalBoardDTO
    let fallbackWindow: SignalWindow
    /// True when we have a personalization profile for this actor.
    /// Drives the eyebrow copy — "FOR YOU" vs "POPULAR WITH COLLECTORS".
    let hasProfile: Bool
    let onSelect: (HomepageCardDTO) -> Void

    // Rationale lookup: slug → short headline. Populated asynchronously
    // as each tile appears. Keyed by slug so tiles that scroll in late
    // still get their chip without re-fetching.
    @State private var rationales: [String: String] = [:]

    private var cards: [HomepageCardDTO] {
        // Prefer windowed momentum when we have a profile — those are
        // the stronger signals. Fallback to top movers so guests see
        // actionable content, not an empty shell.
        let primary = signalBoard.momentum.forWindow(fallbackWindow)
        let fallback = signalBoard.topMovers.forWindow(fallbackWindow)
        let picked = primary.isEmpty ? fallback : primary
        return Array(picked.prefix(6))
    }

    private var eyebrow: String {
        hasProfile ? "FOR YOU" : "POPULAR WITH COLLECTORS"
    }

    private var title: String {
        hasProfile ? "Curated for your style" : "Trending this week"
    }

    var body: some View {
        // Rail is optional — don't render a skeleton for low-data states,
        // just let the page flow on to Market Pulse. Home should never
        // have a dead section.
        if cards.count >= 2 {
            VStack(alignment: .leading, spacing: 12) {
                header
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(cards, id: \.slug) { card in
                            Button {
                                onSelect(card)
                            } label: {
                                ForYouTile(
                                    card: card,
                                    rationale: rationales[card.slug]
                                )
                            }
                            .buttonStyle(.plain)
                            .task(id: card.slug) {
                                await loadRationale(for: card)
                            }
                        }
                    }
                    .padding(.horizontal, PA.Layout.sectionPadding)
                }
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(eyebrow)
                .font(.system(size: 10, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(PA.Colors.accent)
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(PA.Colors.text)
        }
        .padding(.horizontal, PA.Layout.sectionPadding)
    }

    // MARK: - Rationale fetch
    //
    // Best-effort. Never blocks rendering; tiles appear immediately with
    // no chip, then the chip fades in when the explanation lands.
    // We only fetch when the user has a profile — for guests we just
    // skip the call entirely to keep the rail chip-free and quiet.

    private func loadRationale(for card: HomepageCardDTO) async {
        guard hasProfile else { return }
        if rationales[card.slug] != nil { return }
        let response = await PersonalizationService.shared.fetchExplanation(
            slug: card.slug,
            variantRef: nil
        )
        guard
            let explanation = response?.explanation,
            !explanation.headline.isEmpty
        else { return }
        await MainActor.run {
            rationales[card.slug] = explanation.headline
        }
    }
}

// MARK: - For You Tile (compact vertical card)
//
// ~140pt wide portrait tile. Image · name · price · change · rationale.
// Sized to echo the existing CommunityTrendingTile (100×140) but a touch
// wider so the rationale chip can breathe.

private struct ForYouTile: View {
    let card: HomepageCardDTO
    let rationale: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            thumbnail

            Text(card.name)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(PA.Colors.text)
                .lineLimit(1)

            HStack(spacing: 6) {
                Text(priceLabel)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.text)
                ChangePill(
                    changePct: card.changePct,
                    window: card.changeWindow ?? "24H",
                    small: true
                )
            }

            // Rationale chip — fades in when the explanation lands.
            // Reserves a single chip-height row so cards don't reflow.
            if let rationale, !rationale.isEmpty {
                RationaleChip(label: rationale, compact: true)
            } else {
                // Empty spacer matched to chip height to prevent layout
                // jitter as rationales stream in.
                Color.clear.frame(height: 16)
            }
        }
        .padding(10)
        .frame(width: 140, alignment: .leading)
        .background(PA.Gradients.cardSurface)
        .clipShape(RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PA.Layout.cardRadius, style: .continuous)
                .stroke(PA.Colors.borderLight, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(PA.Colors.surfaceSoft)
            if let url = card.displayThumbUrl.flatMap(URL.init(string:)) {
                LazyImage(url: url) { state in
                    if let image = state.image {
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
                .padding(4)
            }
        }
        .frame(height: 120)
    }

    private var priceLabel: String {
        formatPrice(card.marketPrice)
    }
}
