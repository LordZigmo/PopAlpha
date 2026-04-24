import Combine
import PhotosUI
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
    @State private var scanLanguage: ScanLanguage = .en
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showEvalSeeding = false
    @State private var showPickerSheet = false

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

                // Identify status toast — pinned to bottom-center, above
                // the tab bar. Reflects "identifying" while the network
                // call is in flight, and error state if it fails.
                if scanner.isIdentifying || scanner.identifyError != nil {
                    VStack {
                        Spacer()
                        identifyStatusToast
                            .padding(.bottom, 140)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .animation(.easeInOut(duration: 0.2), value: scanner.isIdentifying)
                    .animation(.easeInOut(duration: 0.2), value: scanner.identifyError)
                }
            }
            .ignoresSafeArea()
            .navigationBarHidden(true)
            .navigationDestination(item: $navigateToCard) { card in
                CardDetailView(card: card, scanImageHash: scanner.lastImageHash)
                    .onDisappear {
                        // Resume auto-scanning when the user returns from the detail view (single mode).
                        if scanMode == .single {
                            resetToIdle()
                        }
                    }
            }
            .sheet(isPresented: $showEvalSeeding) {
                EvalSeedingView(mode: .freshPhoto, isPresented: $showEvalSeeding)
            }
            .sheet(isPresented: $showPickerSheet) {
                ScanPickerSheet(
                    matches: scanner.lastMatches,
                    imageHash: scanner.lastImageHash,
                    scanLanguage: scanLanguage,
                    onPick: handlePickerSelection,
                    onDismiss: handlePickerDismiss
                )
            }
            .onChange(of: scanner.lastMatch) { _, newValue in
                handleIdentifyResult(newValue)
            }
            .onChange(of: scanLanguage) { _, newLanguage in
                scanner.scanLanguage = newLanguage
            }
            .onAppear {
                scanner.scanLanguage = scanLanguage
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

            HStack(spacing: 8) {
                statusBadge

                Spacer()

                evalSeedingButton
                libraryPickerButton
                languagePill
            }
            .padding(.horizontal, 20)

            modePill
        }
    }

    // MARK: - Eval seeding button (admin — opens EvalSeedingView)
    //
    // Server-side admin auth gates the actual write, so showing this
    // to non-admins is harmless (their POST would 401). A non-admin
    // tap is a very unlikely foot-shooting path — the button is small
    // and labelled with a flask icon that reads as "experimental."

    private var evalSeedingButton: some View {
        Button {
            PAHaptics.tap()
            showEvalSeeding = true
        } label: {
            Image(systemName: "testtube.2")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 32, height: 32)
                .background(.ultraThinMaterial.opacity(0.5))
                .clipShape(Circle())
        }
    }

    // MARK: - Library picker (scan a saved photo instead of live camera)

    private var libraryPickerButton: some View {
        PhotosPicker(
            selection: $selectedPhotoItem,
            matching: .images,
            photoLibrary: .shared()
        ) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 32, height: 32)
                .background(.ultraThinMaterial.opacity(0.5))
                .clipShape(Circle())
        }
        .disabled(scanner.isIdentifying)
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task {
                await loadAndIdentifyLibraryPhoto(newItem)
                // Reset the selection so picking the same photo twice
                // in a row re-fires the onChange handler.
                await MainActor.run { selectedPhotoItem = nil }
            }
        }
    }

    private func loadAndIdentifyLibraryPhoto(_ item: PhotosPickerItem) async {
        do {
            guard
                let data = try await item.loadTransferable(type: Data.self),
                let image = UIImage(data: data)
            else {
                return
            }
            await scanner.runIdentifyFromLibrary(image: image)
        } catch {
            // Swallow — ScannerHost.runIdentify surfaces network / identify
            // errors via `identifyError`; picker-load failures are rare
            // enough to ignore for v1.
        }
    }

    // MARK: - Language Pill (EN / JP)

    private var languagePill: some View {
        HStack(spacing: 2) {
            ForEach(ScanLanguage.allCases, id: \.self) { lang in
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        scanLanguage = lang
                        PAHaptics.tap()
                    }
                } label: {
                    Text(lang.shortLabel)
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.5)
                        .foregroundStyle(
                            scanLanguage == lang
                                ? PA.Colors.background
                                : .white.opacity(0.6)
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(
                            scanLanguage == lang
                                ? AnyShapeStyle(PA.Colors.accent)
                                : AnyShapeStyle(.clear)
                        )
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(.ultraThinMaterial.opacity(0.5))
        .clipShape(Capsule())
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

    // MARK: - Identify Status Toast (bottom-center of screen)

    @ViewBuilder
    private var identifyStatusToast: some View {
        if let error = scanner.identifyError {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(PA.Colors.negative)
                Text(error)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial.opacity(0.9))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.negative.opacity(0.5), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
        } else {
            HStack(spacing: 8) {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: PA.Colors.accent))
                    .scaleEffect(0.7)
                Text("Identifying…")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial.opacity(0.9))
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(PA.Colors.accent.opacity(0.5), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
        }
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

    private func handleIdentifyResult(_ match: ScanMatch?) {
        guard let match else { return }

        switch scanner.lastConfidence {
        case "high":
            // Zero-tap auto-navigate on high confidence.
            let marketCard = match.toMarketCard()
            if scanMode == .single {
                PAHaptics.tap()
                navigateToCard = marketCard
            } else {
                if !scannedCards.contains(where: { $0.id == marketCard.id }) {
                    scannedCards.append(marketCard)
                    PAHaptics.tap()
                }
                scanner.clearLastMatch()
                scanner.resumeScanning()
            }

        case "medium":
            // Present the top-3 picker so the user can tap the right
            // card. 58% top-5 accuracy in the eval corpus means this
            // almost always contains the correct answer — the user
            // just needs to see it. Silent re-arm throws that away.
            // Only shown in single-card mode; multi-card keeps the
            // existing aggressive behavior since the tray flow assumes
            // autonomous collection.
            if scanMode == .single && !scanner.lastMatches.isEmpty {
                PAHaptics.selection()
                showPickerSheet = true
            } else {
                scanner.clearLastMatch()
                scanner.resumeScanning()
            }

        default:
            // Low confidence (or unknown tier) → silent re-arm.
            scanner.clearLastMatch()
            scanner.resumeScanning()
        }
    }

    /// User picked a card from the ScanPickerSheet. Navigate to it.
    /// The promote-to-eval call is fired from inside the sheet so we
    /// don't need to repeat it here.
    private func handlePickerSelection(_ match: ScanMatch) {
        let marketCard = match.toMarketCard()
        // Defer navigation one tick so the sheet's dismiss animation
        // starts before the nav push — avoids the "sheet still visible
        // as the detail view slides in" UI glitch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            navigateToCard = marketCard
            scanner.clearLastMatch()
        }
    }

    /// User dismissed the sheet without picking — re-arm the scanner.
    private func handlePickerDismiss() {
        scanner.clearLastMatch()
        scanner.resumeScanning()
    }

    private func resetToIdle() {
        scanner.clearLastRecognized()
        scanner.clearLastMatch()
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

    // MARK: - Zero-tap identify state

    @Published private(set) var lastMatch: ScanMatch?
    @Published private(set) var lastConfidence: String?
    @Published private(set) var isIdentifying: Bool = false
    @Published private(set) var identifyError: String?
    /// sha256 hash of the most recently-uploaded scan JPEG. Threaded
    /// through so CardDetailView can fire "this is the wrong card"
    /// corrections against the exact image the identifier saw.
    @Published private(set) var lastImageHash: String?
    /// Full match list from the last identify call. Surfaced so the
    /// picker sheet (shown on medium confidence) can display top-3
    /// candidates for the user to tap-select instead of silently
    /// re-arming. Populated alongside lastMatch; cleared in lockstep.
    @Published private(set) var lastMatches: [ScanMatch] = []

    /// Language hint passed to /api/scan/identify. Defaults to EN; the
    /// scanner UI exposes a pill toggle so the user can flip to JP.
    var scanLanguage: ScanLanguage = .en

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
            self.installNetworkIdentifier(vm)
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

    /// Replaces the package's on-device CoreML classifier with a
    /// network call to /api/scan/identify. Scanner remains paused for
    /// the duration; SwiftUI listens to `lastMatch` + `lastConfidence`
    /// to auto-navigate on "high" confidence results.
    private func installNetworkIdentifier(_ vm: ScannerViewModel) {
        vm.onStableCardCaptured = { [weak self] image in
            guard let self else { return }
            await self.runIdentify(image: image)
        }
    }

    private func runIdentify(image: UIImage) async {
        self.isIdentifying = true
        self.identifyError = nil

        // Run the server identify and on-device OCR concurrently —
        // OCR finishes much faster (~100-300ms) than identify (~1-3s),
        // so joining on both only costs identify's latency. OCR pulls
        // the collector number from the card's bottom corner, which
        // uniquely disambiguates variant prints that CLIP can't
        // distinguish on art alone (e.g. Cramorant-AH vs Cramorant-JT).
        async let identifyTask = ScanService.identify(
            image: image,
            language: self.scanLanguage
        )
        async let ocrTask = OCRService.extractCollectorNumber(from: image)

        do {
            let response = try await identifyTask
            let ocrNumber = await ocrTask

            let reranked = ScanMatchReranker.rerank(
                matches: response.matches,
                originalConfidence: response.confidence,
                ocrCardNumber: ocrNumber
            )

            self.lastMatch = reranked.matches.first
            self.lastMatches = reranked.matches
            self.lastConfidence = reranked.confidence
            self.lastImageHash = response.imageHash
            self.isIdentifying = false

            // Low-confidence → auto-resume so the user can try again
            // without tapping. High/medium results are handled by the
            // view which navigates (high) or displays matches (medium).
            if reranked.confidence == "low" {
                self.lastMatch = nil
                self.resumeScanning()
            }
        } catch {
            self.isIdentifying = false
            self.identifyError = error.localizedDescription
            self.resumeScanning()
        }
    }

    /// Identifies a card from the user's photo library (or any already-
    /// captured UIImage) by feeding it straight through the server
    /// identify pipeline, skipping the Vision rectangle stability gate.
    /// Used by the scanner UI's PhotosPicker button so users can scan
    /// photos they already have — especially useful for building out
    /// the eval corpus from saved captures.
    func runIdentifyFromLibrary(image: UIImage) async {
        // Pause live scanning so the camera's stability gate doesn't
        // also fire an identify concurrently — we only want the library
        // photo's result to drive navigation.
        viewModel?.pauseForExternalCapture()
        isScanning = viewModel?.isScanning ?? false
        await runIdentify(image: image)
    }

    func resumeScanning() {
        viewModel?.resumeScanning()
        isScanning = viewModel?.isScanning ?? true
    }

    func clearLastRecognized() {
        lastRecognized = nil
    }

    func clearLastMatch() {
        lastMatch = nil
        lastMatches = []
        lastConfidence = nil
        identifyError = nil
        lastImageHash = nil
    }
}

// MARK: - ScanMatch → MarketCard converter
// The scan identify response has just enough fields to seed the
// CardDetailView; the view's own .task loads profile + metrics from
// the canonical slug so the zero-tap flow reaches full detail
// fidelity without extra iOS-side work.

private extension ScanMatch {
    func toMarketCard() -> MarketCard {
        MarketCard(
            id: slug,
            name: canonicalName,
            setName: setName ?? "Unknown",
            cardNumber: cardNumber ?? "",
            price: 0,
            changePct: 0,
            changeWindow: "24H",
            rarity: .common,
            sparkline: [0],
            imageGradient: [
                GradientStop(r: 0.1, g: 0.05, b: 0.15),
                GradientStop(r: 0.2, g: 0.1, b: 0.3)
            ],
            imageURL: mirroredPrimaryImageUrl.flatMap { URL(string: $0) },
            confidenceScore: Int((similarity * 100).rounded())
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
