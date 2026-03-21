import SwiftUI

public struct ScannerOverlayContext {
    public let size: CGSize
    public let isScanning: Bool
    public let recognizedCard: PopAlphaCard?
    public let debugIndexLabel: String?
    public let useMockData: Bool

    public init(
        size: CGSize,
        isScanning: Bool,
        recognizedCard: PopAlphaCard?,
        debugIndexLabel: String?,
        useMockData: Bool
    ) {
        self.size = size
        self.isScanning = isScanning
        self.recognizedCard = recognizedCard
        self.debugIndexLabel = debugIndexLabel
        self.useMockData = useMockData
    }
}

public protocol ScannerOverlay {
    func makeOverlay(context: ScannerOverlayContext) -> AnyView
}

public struct DefaultScannerOverlay: ScannerOverlay {
    public init() {}

    public func makeOverlay(context: ScannerOverlayContext) -> AnyView {
        AnyView(
            ZStack {
                scannerFrame(in: context.size, isScanning: context.isScanning)

                if let recognizedCard = context.recognizedCard {
                    banner(cardID: recognizedCard.id)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        )
    }

    @ViewBuilder
    private func scannerFrame(in size: CGSize, isScanning: Bool) -> some View {
        let cardAspectRatio = CGFloat(2.5 / 3.5)
        let boxWidth = min(size.width * 0.72, size.height * 0.45 * cardAspectRatio)
        let boxHeight = boxWidth / cardAspectRatio

        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .stroke(isScanning ? Color.green.opacity(0.95) : Color.yellow.opacity(0.95), lineWidth: 3)
            .frame(width: boxWidth, height: boxHeight)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.black.opacity(0.12))
            )
            .shadow(color: .black.opacity(0.35), radius: 18, y: 12)
    }

    @ViewBuilder
    private func banner(cardID: String) -> some View {
        VStack {
            Spacer()

            VStack(spacing: 4) {
                Text("Card Found!")
                    .font(.headline.weight(.semibold))
                Text(cardID)
                    .font(.subheadline.monospaced())
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(
                Capsule(style: .continuous)
                    .fill(.black.opacity(0.78))
            )
            .padding(.bottom, 32)
        }
        .padding(.horizontal, 20)
    }
}
