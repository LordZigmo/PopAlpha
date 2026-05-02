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
                        handle: "you",
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
            }
            // Block all interactions in the preview — every tap funnels
            // into the sign-up CTA below instead.
            .allowsHitTesting(false)

            // Top-level tap layer that turns any preview interaction
            // into a sign-up prompt. Sits above the disabled scroll
            // content but below the sticky CTA.
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    PAHaptics.tap()
                    AuthService.shared.signIn()
                }
                .padding(.bottom, 140)

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

    private static let demoIdentity = CollectorIdentityProfile(
        primaryType: .modernMomentum,
        confidence: 0.78,
        explanation: "Your collection skews toward recent sets and high-grade modern cards. You're chasing momentum in today's hottest releases — and your portfolio reflects it.",
        traits: [
            CollectorTrait(type: .setFinisher, strength: 0.65),
            CollectorTrait(type: .gradedPurist, strength: 0.42),
        ]
    )

    private static let demoSummary = PortfolioSummary(
        totalValue: 2487.50,
        totalCostBasis: 1942.20,
        changes: [.day: PortfolioChange(amount: 545.30, percent: 28.1)],
        cardCount: 24,
        rawCount: 17,
        gradedCount: 7,
        sealedCount: 0,
        sparkline: [1700, 1740, 1820, 1790, 1880, 1920, 1960, 2030, 2100, 2160, 2220, 2310, 2400, 2487],
        aiSummary: ""
    )

    private static let demoRadar = APIRadarProfile(
        vintage: 0.18,
        graded: 0.55,
        premium: 0.62,
        setFinisher: 0.72,
        japanese: 0.20,
        grailHunter: 0.45
    )

    private static let demoInsights: [PortfolioInsight] = [
        PortfolioInsight(text: "Your portfolio outperformed the modern market by +14.2% over the last 30 days."),
        PortfolioInsight(text: "Your Charizard ex 199 is the strongest performer — up 38% since acquisition."),
        PortfolioInsight(text: "You're 2 cards away from completing the Obsidian Flames master set."),
    ]

    // Demo positions. canonicalSlug is the display fallback when no
    // metadata image is available, so we set it to the card name.
    private static let demoPositions: [Position] = [
        Position(
            key: "charizard-ex-obsidian-flames-199::PSA 10",
            canonicalSlug: "charizard-ex",
            grade: "PSA 10",
            lots: [
                HoldingRow(
                    id: "demo-1",
                    canonicalSlug: "charizard-ex",
                    printingId: nil,
                    grade: "PSA 10",
                    qty: 1,
                    pricePaidUsd: 380.00,
                    acquiredOn: "2025-09-12",
                    venue: "eBay",
                    certNumber: "82145671"
                )
            ]
        ),
        Position(
            key: "pikachu-illustrator-promo::RAW",
            canonicalSlug: "moonbreon",
            grade: "RAW",
            lots: [
                HoldingRow(
                    id: "demo-2",
                    canonicalSlug: "moonbreon",
                    printingId: nil,
                    grade: "RAW",
                    qty: 2,
                    pricePaidUsd: 220.00,
                    acquiredOn: "2025-11-04",
                    venue: "TCGplayer",
                    certNumber: nil
                )
            ]
        ),
        Position(
            key: "iono-svp::PSA 9",
            canonicalSlug: "iono-special-illustration",
            grade: "PSA 9",
            lots: [
                HoldingRow(
                    id: "demo-3",
                    canonicalSlug: "iono-special-illustration",
                    printingId: nil,
                    grade: "PSA 9",
                    qty: 1,
                    pricePaidUsd: 95.00,
                    acquiredOn: "2026-01-22",
                    venue: "LGS",
                    certNumber: "78443210"
                )
            ]
        ),
        Position(
            key: "umbreon-vmax-evs::RAW",
            canonicalSlug: "umbreon-vmax",
            grade: "RAW",
            lots: [
                HoldingRow(
                    id: "demo-4",
                    canonicalSlug: "umbreon-vmax",
                    printingId: nil,
                    grade: "RAW",
                    qty: 3,
                    pricePaidUsd: 60.00,
                    acquiredOn: "2025-08-30",
                    venue: nil,
                    certNumber: nil
                )
            ]
        ),
    ]

    private static let demoMetadata: [String: APICardMetadata] = [
        "charizard-ex": APICardMetadata(
            name: "Charizard ex 199",
            setName: "Obsidian Flames",
            imageUrl: nil,
            marketPrice: 525.00,
            changePct: 38.2
        ),
        "moonbreon": APICardMetadata(
            name: "Umbreon VMAX (Alt Art)",
            setName: "Evolving Skies",
            imageUrl: nil,
            marketPrice: 285.00,
            changePct: 14.5
        ),
        "iono-special-illustration": APICardMetadata(
            name: "Iono SIR 254",
            setName: "Paldean Fates",
            imageUrl: nil,
            marketPrice: 110.00,
            changePct: 6.8
        ),
        "umbreon-vmax": APICardMetadata(
            name: "Umbreon VMAX 95",
            setName: "Evolving Skies",
            imageUrl: nil,
            marketPrice: 72.00,
            changePct: 2.1
        ),
    ]

    private static let demoDescriptors: [String: String] = [
        "charizard-ex-obsidian-flames-199::PSA 10": "Largest holding",
        "iono-svp::PSA 9": "Best performer",
    ]
}

// MARK: - Preview

#Preview("Portfolio Demo") {
    ZStack {
        PA.Colors.background.ignoresSafeArea()
        PortfolioDemoView()
    }
    .preferredColorScheme(.dark)
}
