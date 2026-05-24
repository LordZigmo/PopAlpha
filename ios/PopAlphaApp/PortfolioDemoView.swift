import SwiftUI

// MARK: - Portfolio Demo View
// What unsigned-in users see on the portfolio tab. Mirrors the real
// signed-in experience (collector type, hero, radar, insights, your
// cards) populated with realistic sample data, gated behind a
// "Sign up free" CTA. Pure preview — no interactions.
//
// Goal: turn the portfolio tab from a dead empty state into the most
// compelling sign-up surface in the app.

struct PortfolioDemoView: View {
    @State private var ctaPulse = false

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 28) {
                    previewBadge

                    CollectorIdentityCard(profile: Self.demoIdentity)

                    PortfolioHeroView(
                        summary: Self.demoSummary,
                        selectedWindow: .constant(.day),
                        costBasisGap: nil
                    )

                    CollectorRadarCard(profile: Self.demoRadar)

                    PortfolioInsightView(
                        insights: Self.demoInsights,
                        activities: [],
                        showActivity: false
                    )

                    yourCardsSection
                }
                .padding(.bottom, 160) // room for sticky CTA
                // Neutralize Button-based interactions inside the
                // preview cells (hero window picker, identity
                // disclosure, etc.) so the demo can't navigate or
                // mutate state. `.disabled(true)` instead of
                // `.allowsHitTesting(false)`: the latter sometimes
                // also breaks scroll on the parent ScrollView, while
                // .disabled() leaves the ScrollView's pan gesture
                // intact and only neutralises Buttons/links inside.
                // The radar's `.task`-based animation (not .onAppear)
                // is resilient to both — see CollectorRadarView.
                .disabled(true)
            }
            // Tap anywhere in the demo → sign-in prompt. Simultaneous
            // gesture so the ScrollView's own pan/drag gesture for
            // scrolling still wins on actual scroll motions; a clean
            // tap (no drag) routes to sign-in.
            .simultaneousGesture(
                TapGesture().onEnded {
                    PAHaptics.tap()
                    AuthService.shared.signIn()
                }
            )

            stickyCTA
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                ctaPulse = true
            }
        }
    }

    // MARK: - Preview Badge

    private var previewBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: "eye.fill")
                .font(.system(size: 9, weight: .bold))
            Text("PREVIEW")
                .font(.system(size: 10, weight: .bold))
                .tracking(1.0)
            Text("· what your portfolio will look like")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(PA.Colors.muted)
        }
        .foregroundStyle(PA.Colors.accent)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(PA.Colors.accent.opacity(0.10))
        .clipShape(Capsule())
        .padding(.top, 4)
    }

    // MARK: - Your Cards Section (demo)

    private var yourCardsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 14))
                    .foregroundStyle(PA.Colors.accent)
                Text("Your Cards")
                    .font(PA.Typography.sectionTitle)
                    .foregroundStyle(PA.Colors.text)
                Spacer()
            }
            .padding(.horizontal, PA.Layout.sectionPadding)

            LazyVStack(spacing: 10) {
                ForEach(Self.demoPositions) { position in
                    PortfolioPositionCell(
                        position: position,
                        metadata: Self.demoMetadata[position.canonicalSlug ?? ""],
                        descriptor: Self.demoDescriptors[position.id]
                    )
                }
            }
            .padding(.horizontal, PA.Layout.sectionPadding)
        }
    }

    // MARK: - Sticky CTA

    private var stickyCTA: some View {
        VStack(spacing: 8) {
            Text("Identify your collector type, see what your cards are worth, and track every move.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(PA.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)

            Button {
                PAHaptics.tap()
                AuthService.shared.signIn()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 14, weight: .bold))
                    Text("Sign up free to track yours")
                        .font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(PA.Colors.background)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(PA.Colors.accent)
                .clipShape(Capsule())
                .shadow(color: PA.Colors.accent.opacity(ctaPulse ? 0.45 : 0.2), radius: ctaPulse ? 18 : 10, y: 4)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity)
        .background {
            // Fade the content out behind the CTA so the bar reads
            // clearly on top without a hard edge.
            LinearGradient(
                colors: [
                    PA.Colors.background.opacity(0),
                    PA.Colors.background.opacity(0.85),
                    PA.Colors.background,
                    PA.Colors.background,
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        }
    }

    // MARK: - Demo Data

    // Demo intentionally uses Nostalgia Curator — visually opposite of
    // the most common signed-in collector type (Modern Momentum) — so
    // the sample doesn't read as a clone of the user's real portfolio
    // and the radar shape immediately shows off the variety the
    // classifier can recognise. The 10 supported types are defined in
    // CollectorType (PortfolioModels.swift).
    private static let demoIdentity = CollectorIdentityProfile(
        primaryType: .nostalgiaCurator,
        confidence: 0.82,
        explanation: "Your collection leans heavily on WOTC-era chase cards — Base Set holos, Neo trophies, and graded vintage staples. You're preserving the cards that built the hobby.",
        traits: [
            CollectorTrait(type: .gradedPurist, strength: 0.78),
            CollectorTrait(type: .setFinisher, strength: 0.48),
        ]
    )

    private static let demoSummary = PortfolioSummary(
        totalValue: 9540.00,
        totalCostBasis: 6820.00,
        changes: [.day: PortfolioChange(amount: 148.00, percent: 1.6)],
        cardCount: 38,
        rawCount: 8,
        gradedCount: 30,
        sealedCount: 0,
        sparkline: [6850, 7020, 7180, 7140, 7320, 7450, 7680, 7820, 8050, 8240, 8580, 8920, 9230, 9540],
        aiSummary: ""
    )

    // Tuned to read as "Nostalgia Curator" — peaks on nostalgia + slab,
    // valleys on currentEra + marketHeat. Produces a radar polygon
    // skewed toward the left/top side, visually opposite of the
    // Modern-Momentum-shaped chart most signed-in users see. Values
    // also line up with demoPositions below: heavy on Base / Neo / WOTC
    // graded chase cards.
    private static let demoRadar = APIRadarProfile(
        nostalgia: 0.92,
        currentEra: 0.15,
        slabFocus: 0.78,
        marketHeat: 0.42,
        tasteProfile: 0.74,
        collectionDepth: 0.78
    )

    private static let demoInsights: [PortfolioInsight] = [
        PortfolioInsight(text: "Your WOTC-era holdings outperformed the modern market by +18.4% over the last 30 days."),
        PortfolioInsight(text: "Your PSA 9 Lugia (Neo Genesis) is your strongest position — up 24% since acquisition."),
        PortfolioInsight(text: "92% of your collection is pre-2003 era. Graded vintage tends to outperform raw modern over long horizons."),
    ]

    // Demo positions. canonicalSlugs are real canonical_cards.slug
    // values so the mirrored card-image CDN URLs in demoMetadata below
    // render actual card art. The visible list is a "highlights" view
    // of the 38-card vintage collection summarised in demoSummary —
    // spans Base, Team Rocket, Neo Genesis, Neo Destiny, and a WOTC
    // promo so the mix reads as a focused pre-2003 portfolio.
    private static let demoPositions: [Position] = [
        Position(
            key: "neo-genesis-9-lugia::PSA 9",
            canonicalSlug: "neo-genesis-9-lugia",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-1",
                    canonicalSlug: "neo-genesis-9-lugia",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 1450.00,
                    acquiredOn: "2024-11-08",
                    venue: "PWCC",
                    certNumber: "61124882"
                )
            ]
        ),
        Position(
            key: "base-4-charizard::PSA 7",
            canonicalSlug: "base-4-charizard",
            grade: "PSA 7",
            lots: [
                HoldingRow(
                    id: "demo-2",
                    canonicalSlug: "base-4-charizard",
                    printingId: nil,
                    grade: "PSA 7",
                    qty: 1,
                    pricePaidUsd: 1100.00,
                    acquiredOn: "2024-08-14",
                    venue: "eBay",
                    certNumber: "59218043"
                )
            ]
        ),
        Position(
            key: "neo-destiny-107-shining-charizard::PSA 9",
            canonicalSlug: "neo-destiny-107-shining-charizard",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-3",
                    canonicalSlug: "neo-destiny-107-shining-charizard",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 1280.00,
                    acquiredOn: "2025-03-21",
                    venue: "Goldin",
                    certNumber: "62488019"
                )
            ]
        ),
        Position(
            key: "base-2-blastoise::PSA 9",
            canonicalSlug: "base-2-blastoise",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-4",
                    canonicalSlug: "base-2-blastoise",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 590.00,
                    acquiredOn: "2025-01-10",
                    venue: "PWCC",
                    certNumber: "60291743"
                )
            ]
        ),
        Position(
            key: "base-15-venusaur::PSA 9",
            canonicalSlug: "base-15-venusaur",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-5",
                    canonicalSlug: "base-15-venusaur",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 480.00,
                    acquiredOn: "2025-01-10",
                    venue: "PWCC",
                    certNumber: "60291744"
                )
            ]
        ),
        Position(
            key: "base-10-mewtwo::PSA 10",
            canonicalSlug: "base-10-mewtwo",
            grade: "PSA 10",
            lots: [
                HoldingRow(
                    id: "demo-6",
                    canonicalSlug: "base-10-mewtwo",
                    printingId: nil,
                    grade: "PSA 10",
                    qty: 1,
                    pricePaidUsd: 540.00,
                    acquiredOn: "2025-05-02",
                    venue: "eBay",
                    certNumber: "63110928"
                )
            ]
        ),
        Position(
            key: "wizards-black-star-promos-8-mew::PSA 9",
            canonicalSlug: "wizards-black-star-promos-8-mew",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-7",
                    canonicalSlug: "wizards-black-star-promos-8-mew",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 360.00,
                    acquiredOn: "2025-06-17",
                    venue: "LGS",
                    certNumber: "63884211"
                )
            ]
        ),
        Position(
            key: "team-rocket-4-dark-charizard::PSA 8",
            canonicalSlug: "team-rocket-4-dark-charizard",
            grade: "PSA 8",
            lots: [
                HoldingRow(
                    id: "demo-8",
                    canonicalSlug: "team-rocket-4-dark-charizard",
                    printingId: nil,
                    grade: "PSA 8",
                    qty: 1,
                    pricePaidUsd: 280.00,
                    acquiredOn: "2025-09-25",
                    venue: "eBay",
                    certNumber: "65812907"
                )
            ]
        ),
    ]

    // Mirrored CDN URLs (public storage bucket) — same scheme the
    // signed-in overview API returns, so the demo renders identical
    // card thumbnails to the real portfolio.
    private static let demoMetadata: [String: APICardMetadata] = [
        "neo-genesis-9-lugia": APICardMetadata(
            name: "Lugia 9 (Holo)",
            setName: "Neo Genesis",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/neo-genesis-9-lugia/full.png",
            marketPrice: 1820.00,
            changePct: 24.1
        ),
        "base-4-charizard": APICardMetadata(
            name: "Charizard 4 (Base Set Holo)",
            setName: "Base",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/base-4-charizard/full.png",
            marketPrice: 1400.00,
            changePct: 15.8
        ),
        "neo-destiny-107-shining-charizard": APICardMetadata(
            name: "Shining Charizard 107",
            setName: "Neo Destiny",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/neo-destiny-107-shining-charizard/full.png",
            marketPrice: 1480.00,
            changePct: 12.6
        ),
        "base-2-blastoise": APICardMetadata(
            name: "Blastoise 2 (Holo)",
            setName: "Base",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/base-2-blastoise/full.png",
            marketPrice: 720.00,
            changePct: 8.4
        ),
        "base-15-venusaur": APICardMetadata(
            name: "Venusaur 15 (Holo)",
            setName: "Base",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/base-15-venusaur/full.png",
            marketPrice: 580.00,
            changePct: 6.9
        ),
        "base-10-mewtwo": APICardMetadata(
            name: "Mewtwo 10 (Holo)",
            setName: "Base",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/base-10-mewtwo/full.png",
            marketPrice: 620.00,
            changePct: 4.2
        ),
        "wizards-black-star-promos-8-mew": APICardMetadata(
            name: "Mew 8 (WOTC Promo)",
            setName: "Wizards Black Star Promos",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/wizards-black-star-promos-8-mew/full.png",
            marketPrice: 430.00,
            changePct: 9.1
        ),
        "team-rocket-4-dark-charizard": APICardMetadata(
            name: "Dark Charizard 4 (Holo)",
            setName: "Team Rocket",
            imageUrl: "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/team-rocket-4-dark-charizard/full.png",
            marketPrice: 340.00,
            changePct: 11.2
        ),
    ]

    private static let demoDescriptors: [String: String] = [
        "neo-genesis-9-lugia::PSA 9": "Largest holding",
        "neo-destiny-107-shining-charizard::PSA 9": "Best performer",
    ]
}

// MARK: - Preview

#Preview("Portfolio Demo") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioDemoView()
    }
}
