import Combine
import SwiftUI
import PopAlphaCore
import OSLog

// MARK: - Scanner Tab
//
// Minimal interface, intentionally. The previous version had a status
// badge, mode pill (single/multi), language pill, photos-picker
// button, eval-seeding button, animated tracking brackets around the
// detected card, and a multi-card scroll tray — all of which got
// stripped 2026-05-04 in favor of a clean viewfinder. The whole
// screen is now the shutter (full-screen tap = capture this frame),
// the only persistent surface is the camera preview, and the only
// transient overlay is an "Identifying…" toast. DEBUG builds add
// two compact corner buttons for the smoke test + premium override.
//
// Single-card mode is the only mode. Multi-card collection flow can
// come back when there's a real product use case for it.

struct ScannerTabView: View {
    @State private var navigateToCard: MarketCard?
    @State private var showPickerSheet = false
    #if DEBUG
    @State private var smokeReport: OfflineScannerSmokeReport?
    @State private var smokeRunning = false
    @StateObject private var premiumGate = PremiumGate.shared
    #endif

    // Package-backed recognition
    @StateObject private var scanner = ScannerHost()

    var body: some View {
        NavigationStack {
            ZStack {
                // Camera preview — fills the entire screen. Falls back
                // to solid black if the camera failed to initialize.
                if let viewModel = scanner.viewModel {
                    ScannerView(viewModel: viewModel)
                        .ignoresSafeArea()
                } else {
                    Color.black.ignoresSafeArea()
                }

                // Full-screen tap = capture this frame. The whole
                // viewport IS the shutter. captureFrameAndIdentify
                // implicitly resumes scanning, so this single gesture
                // covers tap-to-restart too. The re-entry guard in
                // runIdentify drops mashed taps as no-ops while a
                // scan is mid-flight or a result is on screen.
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        PAHaptics.tap()
                        Task { await scanner.captureFrameAndIdentify() }
                    }
                    .allowsHitTesting(scanner.initError == nil)

                // Init-error overlay (camera permission denied,
                // hardware failure, etc.). The only visible state
                // when we can't even show a viewfinder.
                if let initError = scanner.initError {
                    initErrorOverlay(message: initError)
                }

                // "Identifying…" toast pinned to the bottom-center
                // above the tab bar. Same toast renders identify
                // errors. Only persistent visual feedback for an
                // in-flight scan.
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

                // DEBUG-only corner buttons for the smoke test +
                // premium override. Top-right so they don't visually
                // dominate the camera viewport. Compile-stripped from
                // release builds — production users never see these.
                #if DEBUG
                VStack {
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            premiumOverrideButton
                            offlineSmokeButton
                        }
                        .padding(.top, 60)
                        .padding(.trailing, 16)
                    }
                    Spacer()
                }
                #endif
            }
            .ignoresSafeArea()
            .navigationBarHidden(true)
            .navigationDestination(item: $navigateToCard) { card in
                CardDetailView(
                    card: card,
                    scanImageHash: scanner.lastImageHash,
                    scanImage: scanner.lastScanImage,
                )
                    .onDisappear {
                        // Belt: re-arm scanner when CardDetailView
                        // pops. SwiftUI's .navigationDestination(item:)
                        // sometimes misses the .onDisappear hook on
                        // back-swipe / tab-switch round-trips; the
                        // .onChange watcher below is the brace.
                        resetToIdle()
                    }
            }
            // Braces: when SwiftUI's .onDisappear misses, this watcher
            // catches the binding transition from non-nil → nil
            // (which IS the pop event) and re-arms. Both hooks call
            // `resetToIdle` which is idempotent — double-fire is harmless.
            .onChange(of: navigateToCard) { oldValue, newValue in
                if oldValue != nil, newValue == nil {
                    resetToIdle()
                }
            }
            .sheet(isPresented: $showPickerSheet) {
                ScanPickerSheet(
                    matches: scanner.lastMatches,
                    imageHash: scanner.lastImageHash,
                    scanImage: scanner.lastScanImage,
                    scanLanguage: .en,
                    ocrCardNumber: scanner.lastOCR.cardNumber,
                    ocrSetHint: scanner.lastOCR.setHint,
                    winningPath: scanner.lastWinningPath,
                    onPick: handlePickerSelection,
                    onDismiss: handlePickerDismiss,
                    onCorrectionSubmitted: {
                        // Anchor sync — the just-submitted user_correction
                        // should reach the offline catalog before the
                        // user's next scan. Non-blocking.
                        scanner.syncOfflineAnchorsInBackground()
                    },
                )
            }
            #if DEBUG
            .sheet(isPresented: smokeSheetBinding) {
                if let report = smokeReport {
                    OfflineSmokeReportSheet(report: report)
                }
            }
            #endif
            .onChange(of: scanner.lastMatch) { _, newValue in
                handleIdentifyResult(newValue)
            }
            .onAppear {
                #if DEBUG
                runSmokeTestIfRequested()
                #endif
            }
        }
    }

    // MARK: - Init-error overlay

    private func initErrorOverlay(message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(PA.Colors.negative)
            Text("Scanner unavailable")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.55))
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .padding(.horizontal, 28)
        }
    }

    // MARK: - Premium override toggle (DEBUG only)
    //
    // Flips PremiumGate's debug override so the offline scanner path
    // fires without a real StoreKit purchase. Crown icon = currently
    // pro (real or override); slashed crown = free.

    #if DEBUG
    private var premiumOverrideButton: some View {
        Button {
            PAHaptics.tap()
            premiumGate.debugOverrideEnabled.toggle()
        } label: {
            Image(systemName: premiumGate.isPro ? "crown.fill" : "crown")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(
                    premiumGate.isPro ? Color.yellow.opacity(0.9) : .white.opacity(0.5)
                )
                .frame(width: 32, height: 32)
                .background(.ultraThinMaterial.opacity(0.5))
                .clipShape(Circle())
        }
    }
    #endif

    // MARK: - Offline smoke-test button + sheet plumbing (DEBUG only)

    #if DEBUG
    private var smokeSheetBinding: Binding<Bool> {
        Binding(
            get: { smokeReport != nil },
            set: { if !$0 { smokeReport = nil } }
        )
    }

    private var offlineSmokeButton: some View {
        Button {
            PAHaptics.tap()
            guard !smokeRunning else { return }
            smokeRunning = true
            Task.detached(priority: .userInitiated) {
                let report = await OfflineScannerSmokeTest.run()
                await MainActor.run {
                    smokeReport = report
                    smokeRunning = false
                }
            }
        } label: {
            ZStack {
                if smokeRunning {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        .scaleEffect(0.6)
                } else {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .frame(width: 32, height: 32)
            .background(.ultraThinMaterial.opacity(0.5))
            .clipShape(Circle())
        }
        .disabled(smokeRunning)
    }

    private func runSmokeTestIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-runOfflineSmoke")
            || ProcessInfo.processInfo.arguments.contains("-debugOfflineIdentifier")
        else {
            return
        }
        guard !smokeRunning, smokeReport == nil else { return }
        smokeRunning = true
        Task.detached(priority: .userInitiated) {
            let report = await OfflineScannerSmokeTest.run()
            // Log each check on its own line so the unified-logging
            // backend doesn't truncate a single multi-line message
            // (which would hide the failure mode of any specific
            // check). Header + footer wrap the per-check entries so
            // log filters can easily scope.
            Logger.scan.notice("=== OFFLINE_SMOKE_BEGIN ===")
            Logger.scan.notice("catalog: \(report.catalogPath)")
            Logger.scan.notice("model:   \(report.modelPath)")
            for check in report.checks {
                Logger.scan.notice("\(check.line)")
            }
            Logger.scan.notice("=== OFFLINE_SMOKE_END (\(report.allPassed ? "ALL PASSED" : "SOME FAILED")) ===")

            // Tier 6: orchestrator end-to-end. Lives in PopAlphaApp
            // (which has the adapter logic) so it can't sit inside
            // PopAlphaCore's smoke test, but we run it under the
            // same launch flag to keep one debug entry point.
            let orch = await MainActor.run { OfflineScanOrchestrator() }
            let img = Self.makeOrchestratorTestImage()
            Logger.scan.debug("=== ORCH_SMOKE_BEGIN ===")
            do {
                let t0 = Date()
                let response = try await orch.identify(
                    image: img,
                    cardNumber: nil,
                    setHint: nil,
                    language: .en,
                    limit: 5,
                )
                let elapsed = Date().timeIntervalSince(t0) * 1000
                let top = response.matches.first
                Logger.scan.debug("elapsed=\(String(format: "%.1f", elapsed))ms confidence=\(response.confidence) winning_path=\(response.winningPath ?? "nil") matches=\(response.matches.count)")
                if let top {
                    Logger.scan.debug("top-1 slug=\(top.slug) name=\"\(top.canonicalName)\" set=\"\(top.setName ?? "nil")\" num=\"\(top.cardNumber ?? "nil")\" sim=\(String(format: "%.4f", top.similarity)) imgURL=\(top.mirroredPrimaryImageUrl ?? "nil")")
                }
                Logger.scan.debug("imageHash=\(response.imageHash ?? "nil")")
                let plumbingOk = top != nil
                    && top?.canonicalName.isEmpty == false
                    && top?.mirroredPrimaryImageUrl != nil
                    && response.imageHash != nil
                Logger.scan.debug("\(plumbingOk ? "ALL ORCH PASSED ✅" : "ORCH FAILED ❌")")
            } catch {
                Logger.scan.debug("error: \(error.localizedDescription)")
                Logger.scan.debug("ORCH FAILED ❌")
            }
            Logger.scan.debug("=== ORCH_SMOKE_END ===")

            await MainActor.run {
                smokeReport = report
                smokeRunning = false
            }
        }
    }

    /// Synthesizes a 384×384 deterministic-noise image for the
    /// orchestrator end-to-end check.
    private static func makeOrchestratorTestImage() -> UIImage {
        let side = 384
        let bytesPerPixel = 4
        let bytesPerRow = side * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: side * bytesPerRow)
        var state: UInt32 = 1234567 &* 1103515245 &+ 12345
        for i in 0..<(side * side) {
            state = state &* 1103515245 &+ 12345
            let r = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let g = UInt8((state >> 16) & 0xFF)
            state = state &* 1103515245 &+ 12345
            let b = UInt8((state >> 16) & 0xFF)
            let off = i * bytesPerPixel
            pixels[off + 0] = r
            pixels[off + 1] = g
            pixels[off + 2] = b
            pixels[off + 3] = 255
        }
        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let cg = CGImage(
            width: side,
            height: side,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: cs,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent,
        )!
        return UIImage(cgImage: cg)
    }
    #endif

    // MARK: - Removed UI helpers (idleBackground, topBar, statusBadge,
    //         modePill, languagePill, libraryPickerButton,
    //         evalSeedingButton, scannerFrame, trackingBrackets,
    //         multiCardTray, multiCardChip, chipPlaceholder,
    //         loadAndIdentifyLibraryPhoto)
    //
    // Stripped 2026-05-04 in favor of a clean viewfinder. See top-of-
    // file comment. Searchable trace for git blame: this stub block
    // is intentionally left so a curious future reader sees what's
    // gone, not just an empty space between two unrelated views.

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

    // MARK: - Recognition handling

    private func handleIdentifyResult(_ match: ScanMatch?) {
        guard let match else { return }

        switch scanner.lastConfidence {
        case "high":
            // Zero-tap auto-navigate on high confidence.
            PAHaptics.tap()
            navigateToCard = match.toMarketCard()

        case "medium":
            // Present the top-3 picker so the user can tap the right
            // card. ~58% top-5 accuracy on the eval corpus means the
            // picker almost always contains the correct answer; silent
            // re-arm would throw that away.
            if !scanner.lastMatches.isEmpty {
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

    /// The UIImage that fed the most recent OFFLINE scan, retained
    /// so the eval-promote correction flow can re-upload bytes via
    /// `promoteEvalFromBytes` when scan-uploads doesn't have them.
    /// Online scans set this to nil because /api/scan/identify
    /// already uploaded the JPEG to scan-uploads/<hash>.jpg and the
    /// existing hash-based promote flow can find it server-side.
    @Published private(set) var lastScanImage: UIImage?

    /// What on-device OCR pulled from the last captured frame
    /// (collector number and/or set-name hint). Surfaced so the
    /// debug overlay in ScanPickerSheet can show what Vision
    /// extracted vs. what the system identified — answers "did
    /// OCR fail or did the route ignore my hints?" during sprint
    /// real-device testing. Compile-stripped in release builds.
    @Published private(set) var lastOCR: (cardNumber: String?, setHint: String?) = (nil, nil)

    /// Which Day 2 retrieval path resolved the most recent scan
    /// (`ocr_direct_unique`, `ocr_intersect_unique`, etc.). Surfaced
    /// in the DEBUG overlay so the operator can see which signal
    /// won — direct DB lookup vs CLIP+OCR intersection vs CLIP-only
    /// fallback.
    @Published private(set) var lastWinningPath: String?

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
    /// Lazily-built offline orchestrator. Only constructed once
    /// PremiumGate.shared.offlineScannerEnabled flips true — keeps
    /// free-tier launches from incurring the model-load cost.
    private var offlineOrchestrator: OfflineScanOrchestrator?

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

    /// Returns the offline orchestrator, initializing it on first
    /// access. Idempotent.
    private func makeOrchestrator() -> OfflineScanOrchestrator {
        if let existing = offlineOrchestrator { return existing }
        let o = OfflineScanOrchestrator()
        offlineOrchestrator = o
        return o
    }

    /// Triggers a non-blocking anchor sync against /api/catalog/anchors-since.
    /// Called from the picker after a correction lands so the just-
    /// submitted user_correction anchor reaches the offline catalog
    /// before the user's next scan. No-op if the orchestrator hasn't
    /// been instantiated yet (free tier; the offline path was never
    /// activated for this session).
    func syncOfflineAnchorsInBackground() {
        offlineOrchestrator?.syncAnchorsInBackground()
    }

    private func runIdentify(image: UIImage) async {
        // RE-ENTRY GUARD. PopAlphaVisionEngine.reset() clears the
        // current stability candidate but does NOT stop frame
        // analysis. So while we're inside an identify call, Vision
        // can detect another stable rectangle and re-fire
        // onStableCardCaptured. Without this guard, that produces
        // concurrent runIdentify calls — and the second one's HIGH
        // result yanks the picker out from under the user when the
        // first one returned MEDIUM.
        //
        // Two reasons to skip:
        //   - isIdentifying: we're already mid-flight.
        //   - lastMatch != nil: a result is sitting on screen waiting
        //     for the user (HIGH navigated to detail, MEDIUM picker
        //     shown). Either way, fresh scans should not steal focus
        //     until the user re-arms via dismiss / detail-view-back /
        //     low-confidence silent re-arm.
        if self.isIdentifying || self.lastMatch != nil {
            Logger.scan.debug("runIdentify dropped — isIdentifying=\(self.isIdentifying) lastMatch=\(self.lastMatch?.slug ?? "nil")")
            return
        }
        self.isIdentifying = true
        self.identifyError = nil
        // Belt-and-braces: clear Vision's stability buffer so the
        // next post-arm re-detection requires a fresh stable window.
        self.viewModel?.pauseForExternalCapture()
        self.isScanning = self.viewModel?.isScanning ?? false

        // Multi-candidate OCR via Vision's beam search (topCandidates(3))
        // PLUS a second pass on the bicubic-upscaled bottom strip —
        // recovers tiny collector-number text the full pass misses
        // under blur. Only the top candidate is sent to the server
        // (legacy single-candidate API); the offline path uses the
        // full list via Path B trial.
        let ocrMulti = await OCRService.extractCardIdentifiersMulti(from: image)
        let ocr = (cardNumber: ocrMulti.cardNumbers.first, setHint: ocrMulti.setHint)
        self.lastOCR = ocr
        Logger.scan.debug("ocr frameSize=\(Int(image.size.width))x\(Int(image.size.height)) cardNumbers=\(ocrMulti.cardNumbers) setHint=\(ocrMulti.setHint ?? "nil")")

        // Offline-first when premium gate is open. On any offline
        // failure (catalog not downloaded, model load error, embed
        // error, identify error) we silently fall back to the
        // network path — free-tier behavior never regresses when
        // premium turns on.
        let offlineEnabled = await MainActor.run { PremiumGate.shared.offlineScannerEnabled }
        var response: ScanIdentifyResponse?
        var usedOffline = false

        if offlineEnabled {
            let orchestrator = await MainActor.run { self.makeOrchestrator() }
            do {
                let r = try await orchestrator.identifyMulti(
                    image: image,
                    cardNumberCandidates: ocrMulti.cardNumbers,
                    setHint: ocrMulti.setHint,
                    language: self.scanLanguage,
                )
                response = r
                usedOffline = true
                Logger.scan.debug("offline winning_path=\(r.winningPath ?? "nil") confidence=\(r.confidence) tried_candidates=\(ocrMulti.cardNumbers)")
            } catch {
                #if DEBUG
                Logger.scan.debug("failed; falling back to network: \(error.localizedDescription)")
                #endif
            }
        }

        do {
            if response == nil {
                response = try await ScanService.identify(
                    image: image,
                    language: self.scanLanguage,
                    cardNumber: ocr.cardNumber,
                    setHint: ocr.setHint
                )
            }
            guard let response else {
                throw ScanServiceError.imageEncodingFailed  // unreachable — keeps the optional checked
            }

            let reranked = ScanMatchReranker.rerank(
                matches: response.matches,
                originalConfidence: response.confidence,
                ocrCardNumber: ocr.cardNumber
            )

            self.lastMatch = reranked.matches.first
            self.lastMatches = reranked.matches
            self.lastConfidence = reranked.confidence
            self.lastImageHash = response.imageHash
            self.lastWinningPath = response.winningPath
            // Retain JPEG-source UIImage only for offline scans —
            // online scans already uploaded to scan-uploads/<hash>.jpg
            // so the correction-via-hash path works without it.
            self.lastScanImage = usedOffline ? image : nil
            self.isIdentifying = false

            Logger.scan.debug("path source=\(usedOffline ? "offline" : "network") winning_path=\(response.winningPath ?? "nil") confidence=\(reranked.confidence)")
            #if DEBUG
            // Save the EXACT frame the embedder saw to Photos for EVERY
            // scan, including HIGH. HIGH-but-wrong is the worst-case
            // failure (auto-navigate to wrong card with no picker
            // recovery) — pre-2026-05-02 we skipped saving HIGH and
            // lost diagnostic data on those cases. Self-documenting:
            // banner overlay carries the result, top-5, OCR.
            let rerankedResponse = ScanIdentifyResponse(
                ok: response.ok,
                confidence: reranked.confidence,
                matches: reranked.matches,
                languageFilter: response.languageFilter,
                modelVersion: response.modelVersion,
                imageHash: response.imageHash,
                winningPath: response.winningPath,
            )
            ScanDebugCapture.capture(
                image: image,
                response: rerankedResponse,
                source: usedOffline ? .offline : .network,
                ocrCardNumbers: ocrMulti.cardNumbers,
                ocrSetHint: ocrMulti.setHint,
            )
            #endif

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
            #if DEBUG
            ScanDebugCapture.capture(
                image: image,
                response: nil,
                source: usedOffline ? .offline : .network,
                ocrCardNumbers: ocrMulti.cardNumbers,
                ocrSetHint: ocrMulti.setHint,
            )
            #endif
            self.resumeScanning()
        }
    }

    /// Identifies a card from the user's photo library (or any already-
    /// captured UIImage) by feeding it straight through the server
    /// identify pipeline, skipping the Vision rectangle stability gate.
    /// `runIdentify` itself now handles the camera pause + re-entry
    /// guard, so the previous explicit pause here was redundant.
    func runIdentifyFromLibrary(image: UIImage) async {
        await runIdentify(image: image)
    }

    /// Manual-capture path. Snapshots the most recent video frame from
    /// the camera and runs identify on it, bypassing Vision's rectangle
    /// detector entirely. The escape hatch for full-art / VMax / ex
    /// cards whose artwork bleeds to the card border — Vision can't
    /// find an edge gradient on those, so the auto-capture path
    /// silently never fires.
    ///
    /// Returns immediately if the camera hasn't produced a frame yet
    /// (e.g., the session is still warming up) or if the simulator
    /// stub is in use (no frameCapturer hook installed there).
    func captureFrameAndIdentify() async {
        guard let capturer = viewModel?.frameCapturer,
              let image = capturer() else {
            return
        }
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
        lastScanImage = nil
        lastOCR = (nil, nil)
        lastWinningPath = nil
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

// MARK: - Previews

#Preview("Scanner") {
    ScannerTabView()
        .preferredColorScheme(.dark)
}
