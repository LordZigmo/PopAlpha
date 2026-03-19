import SwiftUI

public struct GlassMorphScannerOverlay: ScannerOverlay {
    public init() {}

    public func makeOverlay(context: ScannerOverlayContext) -> AnyView {
        AnyView(
            ZStack {
                glassFrame(in: context.size, isScanning: context.isScanning)

                if let debugIndexLabel = context.debugIndexLabel {
                    debugIndex(debugIndexLabel)
                        .transition(.opacity)
                }

                if let recognizedCard = context.recognizedCard {
                    floatingBanner(for: recognizedCard)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        )
    }

    @ViewBuilder
    private func glassFrame(in size: CGSize, isScanning: Bool) -> some View {
        let cardAspectRatio = CGFloat(2.5 / 3.5)
        let boxWidth = min(size.width * 0.74, size.height * 0.46 * cardAspectRatio)
        let boxHeight = boxWidth / cardAspectRatio
        let tint = isScanning ? Color.cyan.opacity(0.95) : Color.mint.opacity(0.95)

        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.ultraThinMaterial.opacity(0.72))
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .strokeBorder(.white.opacity(0.28), lineWidth: 1.2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    tint.opacity(0.95),
                                    .white.opacity(0.9),
                                    tint.opacity(0.55)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 3
                        )
                        .padding(4)
                )
                .overlay(alignment: .topLeading) {
                    cornerAccent(tint: tint)
                        .padding(14)
                }
                .overlay(alignment: .topTrailing) {
                    cornerAccent(tint: tint)
                        .rotationEffect(.degrees(90))
                        .padding(14)
                }
                .overlay(alignment: .bottomLeading) {
                    cornerAccent(tint: tint)
                        .rotationEffect(.degrees(-90))
                        .padding(14)
                }
                .overlay(alignment: .bottomTrailing) {
                    cornerAccent(tint: tint)
                        .rotationEffect(.degrees(180))
                        .padding(14)
                }
        }
        .frame(width: boxWidth, height: boxHeight)
        .shadow(color: tint.opacity(0.25), radius: 28, y: 14)
        .shadow(color: .black.opacity(0.22), radius: 20, y: 12)
    }

    @ViewBuilder
    private func cornerAccent(tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule(style: .continuous)
                .fill(tint)
                .frame(width: 34, height: 4)

            Capsule(style: .continuous)
                .fill(tint)
                .frame(width: 4, height: 34)
        }
        .shadow(color: tint.opacity(0.35), radius: 8)
    }

    @ViewBuilder
    private func floatingBanner(for card: PopAlphaCard) -> some View {
        VStack {
            HStack {
                Spacer()

                VStack(alignment: .leading, spacing: 10) {
                    Text(card.name)
                        .font(.headline.weight(.semibold))
                        .lineLimit(1)

                    bannerDetailRow(card: card)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .background(.ultraThinMaterial)
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(.white.opacity(0.22), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
                .shadow(color: .black.opacity(0.2), radius: 18, y: 10)
            }

            Spacer()
        }
        .padding(.top, 26)
        .padding(.horizontal, 20)
    }

    @ViewBuilder
    private func debugIndex(_ label: String) -> some View {
        VStack {
            HStack {
                Spacer()

                Text(label)
                    .font(.caption2.monospaced().weight(.semibold))
                    .foregroundStyle(.white.opacity(0.36))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.08))
                    .clipShape(Capsule(style: .continuous))
            }

            Spacer()
        }
        .padding(.top, 24)
        .padding(.horizontal, 20)
    }

    @ViewBuilder
    private func bannerDetailRow(card: PopAlphaCard) -> some View {
        HStack(spacing: 8) {
            if let setName = card.setName, !setName.isEmpty {
                detailPill(
                    title: "Set",
                    value: setName,
                    tint: Color.white.opacity(0.14)
                )
            }

            if let price = card.price {
                detailPill(
                    title: "Price",
                    value: price.formatted(.currency(code: "USD")),
                    tint: Color.mint.opacity(0.22)
                )
            }
        }
    }

    @ViewBuilder
    private func detailPill(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white.opacity(0.62))

            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.94))
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(tint)
        .clipShape(Capsule(style: .continuous))
    }
}
