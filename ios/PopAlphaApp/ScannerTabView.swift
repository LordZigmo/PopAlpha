import Combine
import SwiftUI
import NukeUI
import PopAlphaCore

// MARK: - Scan Mode

enum ScanMode: String, CaseIterable {
    case single = "1 Card"
    case multi = "Multiple"
}

// MARK: - Scanner Tab

struct ScannerTabView: View {
    @State private var scanMode: ScanMode = .single
    @State private var scannedCards: [MarketCard] = []
    @State private var navigateToCard: MarketCard?
    @State private var showResultFlash = false

    // Package-backed recognition
    @StateObject private var scanner = ScannerHost()

    var body: some View {
        NavigationStack {
            ZStack {
                // Camera / mock preview from PopAlphaCore — mounted immediately for zero-tap recognition.
                if let viewModel = scanner.viewModel {
                    ScannerView(viewModel: viewModel)
                        .ignoresSafeArea()
                } else {
                    idleBackground
                }

                // Full-screen tap gesture to force a scan restart.
                // Sits behind the interactive overlay (mode pill) so buttons still receive taps first.
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        scanner.resumeScanning()
                    }
                    .allowsHitTesting(scanner.initError == nil)

                // Live tracking brackets that follow the detected card in view space.
                trackingBrackets

                // Overlay UI
                VStack(spacing: 0) {
                    topBar
                    Spacer()
                    scannerFrame
                        .allowsHitTesting(false)
                    Spacer()
                    bottomTray
                }

                // Detection toast — pinned to bottom-center of the screen, above the tab bar.
                // Sits directly below where the physical card is being held.
                if showResultFlash {
                    VStack {
                        Spacer()
                        detectionToast
                            .padding(.bottom, 140)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .ignoresSafeArea()
            .navigationBarHidden(true)
            .navigationDestination(item: $navigateToCard) { card in
                CardDetailView(card: card)
                    .onDisappear {
                        // Resume auto-scanning when the user returns from the detail view (single mode).
                        if scanMode == .single {
                            resetToIdle()
                        }
                    }
            }
            .onChange(of: scanner.lastRecognized) { _, newValue in
                guard let card = newValue else { return }
                handleRecognized(card)
            }
        }
    }

    // MARK: - Idle Background

    private var idleBackground: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.black,
                    Color(red: 0.06, green: 0.08, blue: 0.14)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            RadialGradient(
                colors: [.clear, Color.black.opacity(0.5)],
                center: .center,
                startRadius: 100,
                endRadius: 400
            )
        }
    }

    // MARK: - Top Bar

    private var topBar: some View {
        VStack(spacing: 12) {
            Color.clear.frame(height: 54)

            HStack {
                statusBadge

                Spacer()

                Image(systemName: "bolt.slash.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial.opacity(0.4))
                    .clipShape(Circle())
            }
            .padding(.horizontal, 20)

            modePill
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        if let error = scanner.initError {
            HStack(spacing: 5) {
                Circle().fill(PA.Colors.negative).frame(width: 6, height: 6)
                Text("MODEL ERROR")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1)
                    .foregroundStyle(PA.Colors.negative)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial.opacity(0.6))
            .clipShape(Capsule())
            .help(error)
        } else {
            HStack(spacing: 5) {
                Circle()
                    .fill(scanner.isUsingMockData ? PA.Colors.accent : PA.Colors.positive)
                    .frame(width: 6, height: 6)
                Text(scanner.isUsingMockData ? "SIMULATOR" : "LIVE")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1)
                    .foregroundStyle(scanner.isUsingMockData ? PA.Colors.accent : PA.Colors.positive)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial.opacity(0.6))
            .clipShape(Capsule())
        }
    }

    // MARK: - Mode Pill

    private var modePill: some View {
        HStack(spacing: 0) {
            ForEach(ScanMode.allCases, id: \.self) { mode in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        scanMode = mode
                        scannedCards.removeAll()
                        resetToIdle()
                    }
                } label: {
                    Text(mode.rawValue)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(scanMode == mode ? PA.Colors.background : .white.opacity(0.6))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(
                            scanMode == mode
                                ? AnyShapeStyle(PA.Colors.accent)
                                : AnyShapeStyle(.clear)
                        )
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(.ultraThinMaterial.opacity(0.5))
        .clipShape(Capsule())
        .frame(width: 200)
    }

    // MARK: - Scanner Frame (error state only)
    // The static guide rectangle has been removed. Scan state is now communicated
    // entirely by the live `trackingBrackets` overlay + bottom toast, so this
    // only renders an inline error card if the ScannerViewModel fails to init.

    @ViewBuilder
    private var scannerFrame: some View {
        if scanner.initError != nil {
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(PA.Colors.negative)
                Text("Scanner unavailable")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Text(scanner.initError ?? "")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .padding(.horizontal, 28)
            }
        }
    }

    // MARK: - Tracking Brackets
    // Draws four L-shaped corner brackets at the corners of the live detected
    // card rect, converted from Vision normalized coords to view-space via the
    // preview layer's `layerRectConverted(fromMetadataOutputRect:)`.

    @ViewBuilder
    private var trackingBrackets: some View {
        if let normalized = scanner.candidateBoundingBox,
           let converter = scanner.convertNormalizedRect,
           let viewRect = converter(normalized) {
            TrackingBracketsShape(rect: viewRect, bracketLength: 26)
                .stroke(
                    PA.Colors.positive,
                    style: StrokeStyle(lineWidth: 3, lineCap: .round)
                )
                .animation(.easeOut(duration: 0.12), value: viewRect)
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }

    // MARK: - Detection Toast (bottom-center of screen)

    private var detectionToast: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PA.Colors.positive)
            Text("Yup, it's a card!")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial.opacity(0.9))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(PA.Colors.positive.opacity(0.5), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
    }

    // MARK: - Bottom Tray

    private var bottomTray: some View {
        VStack(spacing: 12) {
            if scanMode == .multi && !scannedCards.isEmpty {
                multiCardTray
                    .padding(.bottom, 100)
            }
        }
    }

    // MARK: - Multi Card Tray

    private var multiCardTray: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(scannedCards) { card in
                    Button {
                        PAHaptics.tap()
                        navigateToCard = card
                    } label: {
                        multiCardChip(card)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
        .frame(height: 72)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func multiCardChip(_ card: MarketCard) -> some View {
        HStack(spacing: 8) {
            if let url = card.imageURL {
                LazyImage(url: url) { state in
                    if let img = state.image {
                        img.resizable().aspectRatio(63.0 / 88.0, contentMode: .fill)
                    } else {
                        chipPlaceholder
                    }
                }
                .frame(width: 36, height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            } else {
                chipPlaceholder
                    .frame(width: 36, height: 50)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(card.name)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PA.Colors.text)
                    .lineLimit(1)
                Text(card.formattedPrice)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(PA.Colors.accent)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private var chipPlaceholder: some View {
        Rectangle()
            .fill(PA.Colors.surfaceSoft)
            .overlay(
                Image("PopAlphaLogoTransparent")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 14, height: 14)
                    .opacity(0.2)
            )
    }

    // MARK: - Recognition handling

    private func handleRecognized(_ popCard: PopAlphaCard) {
        // The shipped model is a binary card DETECTOR, not an identifier —
        // its only class label is "pokemon_card". We intentionally ignore the
        // LabelMapper's round-robin PopAlphaCard fallback here and just surface
        // a quick "yup, something card-shaped is in frame" acknowledgment.
        // When the real identifier lands, swap this out to push CardDetailView.
        _ = popCard

        withAnimation(.easeOut(duration: 0.2)) {
            showResultFlash = true
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation(.easeIn(duration: 0.25)) {
                showResultFlash = false
            }
            scanner.clearLastRecognized()
            scanner.resumeScanning()
        }
    }

    private func resetToIdle() {
        showResultFlash = false
        scanner.clearLastRecognized()
        scanner.resumeScanning()
    }
}

// MARK: - Scanner Host
// Wraps PopAlphaCore's ScannerViewModel in an @ObservableObject the SwiftUI view can bind to.
// Keeps init-error handling + simulator fallback in one place.

@MainActor
final class ScannerHost: ObservableObject {
    @Published private(set) var lastRecognized: PopAlphaCard?
    @Published private(set) var isScanning: Bool = true
    @Published private(set) var initError: String?
    @Published private(set) var candidateBoundingBox: CGRect?

    let viewModel: ScannerViewModel?
    let isUsingMockData: Bool

    /// Vision-normalized → view-space converter installed by the package's
    /// `ScannerCameraViewController` once its preview layer has laid out.
    var convertNormalizedRect: ((CGRect) -> CGRect?)? {
        viewModel?.normalizedRectConverter
    }

    private var observers: [NSKeyValueObservation] = []
    private var cancellable: AnyObject?

    init() {
        #if targetEnvironment(simulator)
        let useMock = true
        #else
        let useMock = false
        #endif
        self.isUsingMockData = useMock

        do {
            let vm = try ScannerViewModel(useMockData: useMock)
            self.viewModel = vm
            self.initError = nil
            // Mirror VM published state. Simple polling via Combine sink.
            self.bind(vm)
        } catch {
            self.viewModel = nil
            self.initError = error.localizedDescription
        }
    }

    private func bind(_ vm: ScannerViewModel) {
        // Observe via Combine on the VM's objectWillChange — pull current values each tick.
        // (ScannerViewModel is an ObservableObject with @Published properties.)
        let c = vm.objectWillChange.sink { [weak self, weak vm] _ in
            guard let self, let vm else { return }
            // objectWillChange fires before the change, so dispatch to next runloop tick.
            DispatchQueue.main.async {
                self.isScanning = vm.isScanning
                if self.lastRecognized?.id != vm.recognizedCard?.id {
                    self.lastRecognized = vm.recognizedCard
                }
                if self.candidateBoundingBox != vm.candidateBoundingBox {
                    self.candidateBoundingBox = vm.candidateBoundingBox
                }
            }
        }
        self.cancellable = c
    }

    func resumeScanning() {
        viewModel?.resumeScanning()
        isScanning = viewModel?.isScanning ?? true
    }

    func clearLastRecognized() {
        lastRecognized = nil
    }
}

// MARK: - PopAlphaCard → MarketCard converter

private extension PopAlphaCard {
    func toMarketCard() -> MarketCard {
        let p = price ?? 0
        return MarketCard(
            id: id,
            name: name,
            setName: setName ?? "Unknown",
            cardNumber: "",
            price: p,
            changePct: 0,
            changeWindow: "24H",
            rarity: CardService.classifyRarityForPrice(p),
            sparkline: [p],
            imageGradient: [
                GradientStop(r: 0.1, g: 0.05, b: 0.15),
                GradientStop(r: 0.2, g: 0.1, b: 0.3)
            ],
            imageURL: nil,
            confidenceScore: nil
        )
    }
}

// MARK: - Tracking Brackets Shape
// Draws four L-shaped corner brackets at the corners of `rect` (in view-space pixels).
// CGRect conforms to Animatable via animatableData, so rect transitions smoothly.

private struct TrackingBracketsShape: Shape {
    var rect: CGRect
    var bracketLength: CGFloat

    var animatableData: CGRect.AnimatableData {
        get { rect.animatableData }
        set { rect.animatableData = newValue }
    }

    func path(in _: CGRect) -> Path {
        var path = Path()
        let r = rect
        let L = min(bracketLength, min(r.width, r.height) * 0.35)

        // Top-left
        path.move(to: CGPoint(x: r.minX, y: r.minY + L))
        path.addLine(to: CGPoint(x: r.minX, y: r.minY))
        path.addLine(to: CGPoint(x: r.minX + L, y: r.minY))

        // Top-right
        path.move(to: CGPoint(x: r.maxX - L, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.minY + L))

        // Bottom-left
        path.move(to: CGPoint(x: r.minX, y: r.maxY - L))
        path.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        path.addLine(to: CGPoint(x: r.minX + L, y: r.maxY))

        // Bottom-right
        path.move(to: CGPoint(x: r.maxX - L, y: r.maxY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - L))

        return path
    }
}

// MARK: - Scanner Corner Shape (legacy, unused after tracking brackets shipped)

struct ScannerCorner: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
        return path
    }
}

// MARK: - Previews

#Preview("Scanner") {
    ScannerTabView()
        .preferredColorScheme(.dark)
}
