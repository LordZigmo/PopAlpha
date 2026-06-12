import AVFoundation
import ImageIO
import OSLog
import SwiftUI
import UIKit

@available(iOS 17.0, *)
public struct ScannerView: View {
    @ObservedObject private var viewModel: ScannerViewModel
    private let overlay: any ScannerOverlay

    public init(
        viewModel: ScannerViewModel,
        overlay: any ScannerOverlay = GlassMorphScannerOverlay()
    ) {
        self.viewModel = viewModel
        self.overlay = overlay
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack {
                if viewModel.useMockData {
                    ScannerSimulatorPreview()
                } else {
                    ScannerCameraPreview(viewModel: viewModel, engine: viewModel.visionEngine)
                }
            }
            .ignoresSafeArea()
            .overlay {
                overlay.makeOverlay(
                    context: ScannerOverlayContext(
                        size: geometry.size,
                        isScanning: viewModel.isScanning,
                        recognizedCard: viewModel.recognizedCard,
                        debugIndexLabel: viewModel.debugIndexLabel,
                        useMockData: viewModel.useMockData
                    )
                )
                .allowsHitTesting(false)
            }
            .background(Color.black)
            .animation(.easeInOut(duration: 0.2), value: viewModel.recognizedCardID)
            .task(id: viewModel.simulatorTaskID) {
                await maybeTriggerSimulatorDetection()
            }
        }
    }

    private func maybeTriggerSimulatorDetection() async {
        guard viewModel.useMockData, viewModel.isScanning, viewModel.recognizedCard == nil else {
            return
        }

        try? await Task.sleep(for: .milliseconds(650))

        guard !Task.isCancelled else {
            return
        }

        await MainActor.run {
            viewModel.triggerMockDetection()
        }
    }
}

@available(iOS 17.0, *)
private struct ScannerSimulatorPreview: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.black,
                    Color(red: 0.08, green: 0.11, blue: 0.17)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 10) {
                Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                    .font(.system(size: 38, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))

                Text("Simulator Mode")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)

                Text("Mock card data will drive the found-card flow.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
            }
            .padding(24)
        }
    }
}

@available(iOS 17.0, *)
private struct ScannerCameraPreview: UIViewControllerRepresentable {
    let viewModel: ScannerViewModel
    let engine: PopAlphaVisionEngine

    func makeUIViewController(context: Context) -> ScannerCameraViewController {
        ScannerCameraViewController(viewModel: viewModel, engine: engine)
    }

    func updateUIViewController(_ uiViewController: ScannerCameraViewController, context: Context) {
        uiViewController.updatePreviewOrientation()
    }
}

@available(iOS 17.0, *)
private final class ScannerCameraViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let captureSession = AVCaptureSession()
    private let previewView = CameraPreviewView()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "com.popalpha.scanner.camera-session", qos: .userInitiated)
    private let sampleBufferQueue = DispatchQueue(label: "com.popalpha.scanner.sample-buffer", qos: .userInitiated)
    private weak var viewModel: ScannerViewModel?
    private let engine: PopAlphaVisionEngine

    private var isSessionConfigured = false
    /// Intent flag, sessionQueue-confined: true while the UI wants live
    /// frames (set on creation/appear, cleared on disappear). Lets
    /// configuration completion start the session itself instead of
    /// depending on `viewDidAppear` ordering — a session that finished
    /// configuring after the appearance callback used to stay stopped
    /// FOREVER with no error ("Starting camera…" black screen,
    /// real-device 2026-06-12).
    private var shouldBeRunning = false
    private var hasInstalledConverter = false
    private let cameraPosition: AVCaptureDevice.Position = .back
    /// Most recent pixel buffer the video output produced. Held so a
    /// manual capture (the "shutter" button on the scanner overlay) can
    /// snapshot the current frame on demand. Replaced every frame via
    /// `captureOutput` — only one buffer is retained at a time so we
    /// don't starve `AVCaptureVideoDataOutput`'s buffer pool. Reads
    /// from `captureCurrentFrame` happen on whatever queue the user
    /// taps the button on, so a lock guards the assignment.
    private var latestPixelBuffer: CVPixelBuffer?
    private var latestPixelBufferOrientation: CGImagePropertyOrientation = .right
    private let latestFrameLock = NSLock()
    private let frameRenderContext = CIContext(options: nil)

    init(viewModel: ScannerViewModel, engine: PopAlphaVisionEngine) {
        self.viewModel = viewModel
        self.engine = engine
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        videoOutput.setSampleBufferDelegate(nil, queue: nil)
    }

    override func loadView() {
        view = previewView
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        previewView.previewLayer?.session = captureSession
        previewView.previewLayer?.videoGravity = .resizeAspectFill

        configureCameraAccess()
        registerSessionObservers()
        // Creation IS intent to run — this VC only exists while the
        // scanner UI is on screen. Don't rely solely on viewDidAppear
        // to start the session: if appearance callbacks fire before
        // configuration completes (or get swallowed by the SwiftUI
        // container), the old flow left a configured session stopped
        // forever. startSessionIfNeeded sets the intent flag; actual
        // start happens whenever configuration finishes, on the same
        // serial queue. viewWillDisappear still stops cleanly.
        startSessionIfNeeded()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startSessionIfNeeded()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updatePreviewOrientation()
        installNormalizedRectConverterIfNeeded()
    }

    private func installNormalizedRectConverterIfNeeded() {
        guard !hasInstalledConverter, let viewModel else { return }
        guard let layer = previewView.previewLayer else { return }
        hasInstalledConverter = true
        let converter: (CGRect) -> CGRect? = { [weak layer] visionBLPortrait in
            guard let layer else { return nil }
            // Vision returns coordinates in portrait-oriented BL space because we
            // pass `.right` as the CGImagePropertyOrientation to VNImageRequestHandler
            // (the raw sensor is landscape, Vision rotates the coordinate system).
            //
            // `layerRectConverted(fromMetadataOutputRect:)` on the other hand expects
            // its input in the DEVICE'S NATIVE VIDEO ORIENTATION — which for the back
            // camera is landscape-right, top-left origin. So we need to undo Vision's
            // rotation (90° CCW in coordinate space) and flip the y-axis.
            //
            // Transform: portrait BL (vx, vy) → landscape TL (1 - vy, 1 - vx).
            // Applied to a rect, this swaps width and height and repositions the origin:
            let landscapeRect = CGRect(
                x: 1 - visionBLPortrait.origin.y - visionBLPortrait.height,
                y: 1 - visionBLPortrait.origin.x - visionBLPortrait.width,
                width: visionBLPortrait.height,
                height: visionBLPortrait.width
            )
            return layer.layerRectConverted(fromMetadataOutputRect: landscapeRect)
        }
        // Assign on the main actor since ScannerViewModel is @MainActor.
        // Same install pattern is used for the frame capturer so the
        // app layer's manual-capture button can snapshot the current
        // video frame for cards Vision can't auto-detect (full-art /
        // VMax / ex cards whose art bleeds to the card border).
        let capturer: @Sendable () -> UIImage? = { [weak self] in
            self?.captureCurrentFrame()
        }
        // OCR-only capturer that returns the FULL oriented frame
        // (no center-crop). The 0.85 center-crop the embedder uses to
        // remove background from SigLIP input also strips the bottom
        // 7.5% of the camera frame — which is exactly where the
        // collector number prints on a card held filling the view.
        // OCR runs on this wider image so the bottom-strip text is in
        // scope; the embedder still gets the tight crop. Real-device
        // 2026-05-04: White Flare Hydreigon ex repeatedly produced
        // cardNumbers=[] not because the regex was rejecting the
        // number, but because the cropped image never contained the
        // number to begin with.
        let fullFrameCapturer: @Sendable () -> UIImage? = { [weak self] in
            self?.captureFullFrame()
        }
        Task { @MainActor [weak viewModel] in
            viewModel?.normalizedRectConverter = converter
            viewModel?.frameCapturer = capturer
            viewModel?.fullFrameCapturer = fullFrameCapturer
        }
    }

    func updatePreviewOrientation() {
        let rotationAngle = interfaceRotationAngle()

        if let previewConnection = previewView.previewLayer?.connection,
           previewConnection.isVideoRotationAngleSupported(rotationAngle) {
            previewConnection.videoRotationAngle = rotationAngle
        }

        if let outputConnection = videoOutput.connection(with: .video),
           outputConnection.isVideoRotationAngleSupported(rotationAngle) {
            outputConnection.videoRotationAngle = rotationAngle
        }
    }

    private static let cameraDeniedMessage = "Camera access is off. Enable it in Settings to scan cards."
    private static let cameraUnavailableMessage = "The camera is unavailable on this device."

    /// Surfaces a camera bring-up failure to the view model on the main
    /// actor. `ScannerHost` mirrors `cameraSetupFailure` into `initError`,
    /// so the scanner shows an actionable overlay instead of a permanent
    /// "Starting camera…" placeholder (the session never starts on
    /// denial, so no frame ever arrives and `firstFrameRendered` never
    /// flips).
    private func reportCameraSetupFailure(_ message: String) {
        Task { @MainActor [weak viewModel] in
            viewModel?.reportCameraSetupFailure(message)
        }
    }

    /// Breadcrumb for the "Starting camera…" diagnostic readout — a
    /// session that silently never starts is otherwise invisible.
    private func noteSessionDiagnostic(_ state: String) {
        Task { @MainActor [weak viewModel] in
            viewModel?.noteSessionDiagnostic(state)
        }
    }

    private func configureCameraAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            noteSessionDiagnostic("permission ok — configuring")
            configureSessionIfNeeded()
        case .notDetermined:
            noteSessionDiagnostic("awaiting camera permission")
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard let self else { return }
                guard granted else {
                    self.reportCameraSetupFailure(Self.cameraDeniedMessage)
                    return
                }
                self.noteSessionDiagnostic("permission granted — configuring")
                self.configureSessionIfNeeded()
                self.startSessionIfNeeded()
            }
        case .denied, .restricted:
            reportCameraSetupFailure(Self.cameraDeniedMessage)
        @unknown default:
            reportCameraSetupFailure(Self.cameraDeniedMessage)
        }
    }

    private func configureSessionIfNeeded() {
        sessionQueue.async {
            guard !self.isSessionConfigured else {
                return
            }

            // The begin/commit transaction lives in its own scope so the
            // deferred commitConfiguration() fires BEFORE anything after
            // the block — startRunning() inside an open configuration
            // transaction starts a session whose input/output additions
            // haven't been applied yet (running but frameless).
            let configured: Bool = {
                self.captureSession.beginConfiguration()
                self.captureSession.sessionPreset = .high

                defer {
                    self.captureSession.commitConfiguration()
                }

                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: self.cameraPosition),
                      let input = try? AVCaptureDeviceInput(device: device),
                      self.captureSession.canAddInput(input) else {
                    self.reportCameraSetupFailure(Self.cameraUnavailableMessage)
                    return false
                }

                self.captureSession.addInput(input)
            // Configure focus / exposure / white-balance for the scanner's
            // actual use case: a small, close-up, mostly-stationary card
            // ~10 inches from the lens. AVCapture's default focus mode is
            // optimized for general photography (mid- to far-range scenes),
            // which left the AF motor visibly hunting on close-up cards
            // ("I have to wave the phone around"). Continuous AF + .near
            // range restriction biases the motor toward near depths so it
            // locks within ~0.3-0.5s instead of hunting to infinity.
            //
            // We deliberately do NOT enable subject-area-change monitoring
            // here, even though it's the textbook pattern from "AVCam:
            // Building a Camera App." Reason: re-anchoring focus on every
            // scene shift produces a momentary blur in the video output
            // right when Vision is trying to lock onto a stable rectangle,
            // causing the scanner to re-fire repeatedly without ever
            // making a selection. Continuous AF alone handles scene shifts
            // without that disruption.
            self.configureFocusAndExposure(on: device)

            self.videoOutput.alwaysDiscardsLateVideoFrames = true
            self.videoOutput.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            self.videoOutput.setSampleBufferDelegate(self, queue: self.sampleBufferQueue)

            guard self.captureSession.canAddOutput(self.videoOutput) else {
                self.reportCameraSetupFailure(Self.cameraUnavailableMessage)
                return false
            }

            self.captureSession.addOutput(self.videoOutput)

            if let outputConnection = self.videoOutput.connection(with: .video) {
                outputConnection.videoRotationAngle = 0
            }

            return true
            }()

            guard configured else { return }

            self.isSessionConfigured = true
            self.noteSessionDiagnostic("session configured")

            // Start immediately if the UI already asked for frames —
            // this is the path that fixes "configured after the
            // appearance callback ⇒ never started" (black placeholder
            // forever). Runs strictly AFTER commitConfiguration (the
            // transaction block above has ended), on the same serial
            // queue, so no race with the start/stop intents.
            if self.shouldBeRunning, !self.captureSession.isRunning {
                self.captureSession.startRunning()
                self.noteSessionDiagnostic(
                    self.captureSession.isRunning ? "session running" : "startRunning returned but session not running"
                )
            }

            DispatchQueue.main.async {
                self.updatePreviewOrientation()
            }
        }
    }

    private func startSessionIfNeeded() {
        sessionQueue.async {
            self.shouldBeRunning = true
            guard self.isSessionConfigured, !self.captureSession.isRunning else {
                return
            }

            self.captureSession.startRunning()
            self.noteSessionDiagnostic(
                self.captureSession.isRunning ? "session running" : "startRunning returned but session not running"
            )
        }
    }

    private func stopSession() {
        sessionQueue.async {
            self.shouldBeRunning = false
            guard self.captureSession.isRunning else {
                return
            }

            self.captureSession.stopRunning()
        }
    }

    // AVCaptureSession stops on a runtime error (e.g. mediaservices
    // reset) or an interruption (incoming call, Control Center, another
    // app taking the camera, multitasking) and does NOT restart on its
    // own. Without these observers the scanner froze on its last frame
    // until the user left and re-entered the tab. Restart on the session
    // queue once the session is configured but no longer running. These
    // notifications can be delivered off the main thread, so the
    // handlers touch no UI state — only the session queue.
    private func registerSessionObservers() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleSessionRuntimeError(_:)),
                           name: .AVCaptureSessionRuntimeError, object: captureSession)
        center.addObserver(self, selector: #selector(handleSessionInterruptionEnded(_:)),
                           name: .AVCaptureSessionInterruptionEnded, object: captureSession)
    }

    @objc private func handleSessionRuntimeError(_ notification: Notification) {
        restartSessionIfStopped()
    }

    @objc private func handleSessionInterruptionEnded(_ notification: Notification) {
        restartSessionIfStopped()
    }

    private func restartSessionIfStopped() {
        sessionQueue.async { [weak self] in
            guard let self, self.isSessionConfigured, !self.captureSession.isRunning else { return }
            self.captureSession.startRunning()
        }
    }

    /// Sets focus / exposure / white-balance on the given device with
    /// hints that match the scanner's near-subject use case. Each
    /// setter is gated on the corresponding `is...Supported` flag so a
    /// device without (e.g.) `.near` range restriction silently
    /// inherits the previous default for that property — no crash, no
    /// regression vs. pre-config behavior.
    ///
    /// Runs on `sessionQueue` (called from `configureSessionIfNeeded`).
    /// `lockForConfiguration` blocks the entire device, so doing it
    /// once at setup is critical — the per-frame video output path
    /// would deadlock if it tried to lock concurrently.
    ///
    /// Notably absent: `isSubjectAreaChangeMonitoringEnabled`. The
    /// textbook AVCam pattern subscribes to subject-area-change
    /// notifications and re-anchors focus to center on each fire. We
    /// tried that and it caused the Vision rectangle stability gate to
    /// trip on the AF-induced blur, sending the scanner into a
    /// re-fire loop that never made a selection. Continuous AF + AE +
    /// AWB without explicit re-anchoring handles scene shifts
    /// gracefully on its own; the camera's continuous algorithms ARE
    /// the subject-area response we want.
    private func configureFocusAndExposure(on device: AVCaptureDevice) {
        do {
            try device.lockForConfiguration()
        } catch {
            return
        }
        defer { device.unlockForConfiguration() }

        // Continuous AF: re-runs the AF algorithm whenever the scene
        // settles into a new stable state. Right behavior for a
        // scanner where the user might pan across a binder of cards.
        if device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusMode = .continuousAutoFocus
        }
        // Near-range hint. The scanner's use case is a card 6-12 inches
        // from the lens; without this the AF motor sweeps the full
        // depth range looking for any subject of any size, which is
        // why pre-fix the user saw visible "hunting."
        if device.isAutoFocusRangeRestrictionSupported {
            device.autoFocusRangeRestriction = .near
        }
        // Continuous AE: scanner sessions cross indoor lighting +
        // window light + flash transitions. Locked exposure would
        // wash out or under-expose half the captures.
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
        }
        // Continuous AWB: keeps card colors consistent across lighting.
        // Cool/warm shifts otherwise bias SigLIP-2's color-channel
        // features, which tightens the embedding cluster on a different
        // visual axis than card-content similarity.
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let orientation = cgImageOrientation(for: connection.videoRotationAngle)
        // Stash the latest frame so the manual-capture path can snapshot
        // it on demand. Replaces (rather than appends) so the buffer pool
        // can reclaim the prior frame — holding multiple frames would
        // eventually starve the pool. Lock keeps the read in
        // captureCurrentFrame from racing the write here.
        if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            latestFrameLock.lock()
            let wasFirstFrame = (latestPixelBuffer == nil)
            latestPixelBuffer = pixelBuffer
            latestPixelBufferOrientation = orientation
            latestFrameLock.unlock()

            // First sample buffer of this session — flip the
            // firstFrameRendered flag so the SwiftUI loading placeholder
            // can hand the screen over to the real preview layer.
            // Dispatched to MainActor because ScannerViewModel is
            // @MainActor-isolated and this callback runs on the
            // sample-buffer queue.
            if wasFirstFrame, let viewModel {
                Task { @MainActor [weak viewModel] in
                    viewModel?.markFirstFrameRendered()
                }
            }
        }
        engine.process(sampleBuffer: sampleBuffer, orientation: orientation)
    }

    /// Returns the FULL oriented camera frame with no center-crop, for
    /// OCR. Pairs with `captureCurrentFrame` (the embedder path which
    /// crops to remove background): both read from the same latest
    /// pixel buffer so the OCR text and the embedded crop are
    /// guaranteed to come from the same instant in time. The collector
    /// number prints in the bottom 5% of the card; on cards held
    /// filling the viewfinder that's exactly what `captureCurrentFrame`'s
    /// 0.85 center-crop strips, so OCR has to see the wider image to
    /// keep the X/Y in scope.
    func captureFullFrame() -> UIImage? {
        latestFrameLock.lock()
        let pixelBuffer = latestPixelBuffer
        let orientation = latestPixelBufferOrientation
        latestFrameLock.unlock()
        guard let pixelBuffer else { return nil }
        let ci = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let extent = ci.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        guard let cg = frameRenderContext.createCGImage(ci, from: extent) else {
            return nil
        }
        return UIImage(cgImage: cg)
    }

    /// Snapshot the most recent video frame as a `UIImage`, cropped to
    /// just the card region. Used by the scanner's manual capture
    /// button. Returns nil if the camera hasn't produced a frame yet
    /// (e.g., session is still warming up).
    ///
    /// Two-tier crop strategy:
    ///
    ///   1. **Vision-detect-on-tap (preferred).** Run a one-shot
    ///      VNDetectRectanglesRequest on the captured frame. If a
    ///      rectangle scores above the confidence threshold, crop to
    ///      it (with 4% padding) — same logic the continuous
    ///      auto-detect path uses to feed the embedder a tight crop.
    ///      Cost: ~10-20ms per tap. Wins: card_number row preserved
    ///      (the dumb 0.85 center-crop trims it on full-frame cards),
    ///      better embedder input (just card content, no background
    ///      pixels diluting the cluster), works regardless of how the
    ///      user frames the card.
    ///
    ///   2. **0.85 center-crop (fallback).** Used when Vision can't
    ///      lock on a rectangle in this single frame — e.g., very
    ///      poor lighting, full-bleed art card with no edge contrast,
    ///      heavy hand occlusion. Trims 7.5% from each side of the
    ///      camera frame, centered. Same logic as before. Acts as a
    ///      safety net so a tap always produces *some* image rather
    ///      than failing silently.
    ///
    /// Real-device 2026-05-05: Cinderace V tap-captured with the
    /// center-crop alone returned Hydreigon ex White Flare at top-1
    /// because (a) the bottom 7.5% containing card_number=44 was
    /// trimmed, so OCR couldn't fire Path B intersection, and (b)
    /// SigLIP couldn't distinguish the phone-camera Cinderace V
    /// embedding from the dark V-card cluster. Vision-detect-on-tap
    /// fixes (a) — OCR sees the card_number, Path B fires, Cinderace
    /// V wins via dual-signal regardless of kNN ranking.
    func captureCurrentFrame() -> UIImage? {
        latestFrameLock.lock()
        let pixelBuffer = latestPixelBuffer
        let orientation = latestPixelBufferOrientation
        latestFrameLock.unlock()
        guard let pixelBuffer else { return nil }
        let ci = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let extent = ci.extent
        guard extent.width > 0, extent.height > 0 else { return nil }

        // Render the FULL oriented frame to a UIImage. Vision needs a
        // CGImage to run rectangle detection, and the same UIImage
        // also feeds the center-crop fallback below — one render for
        // both paths.
        guard let fullCG = frameRenderContext.createCGImage(ci, from: extent) else {
            return nil
        }
        let fullImage = UIImage(cgImage: fullCG)

        // Tier 1 — Vision-detect-on-tap. ~10-20ms per call. The engine
        // reuses the same VNDetectRectanglesRequest configuration
        // (loosened confidence + quadrature thresholds, card aspect
        // ratio bounds) that powers continuous auto-detect, so tuning
        // stays in one place.
        //
        // Sanity check on the detected crop (added 2026-05-08 after
        // real-device evidence of `tap_detect: hit=true` returning
        // 112×116 sub-card noise regions — Vision's loosened threshold
        // is generous enough to lock onto card-icon shapes, glare
        // patches, or rules-text rectangles inside the card art on
        // full-art / VMax / VSTAR cards). Reject anything smaller than
        // 300×400 short-side, or with aspect ratio outside the 0.55–
        // 0.95 portrait card range. Pre-fix, these noise locks degraded
        // the embedder by feeding it 112×116 sub-images instead of the
        // full card; post-fix, they fall through to the center-crop
        // fallback which sees the actual card.
        // Phase 0d (2026-05-15): publish the perspective-correction
        // diagnostic to the engine's stash ONLY when the detected crop
        // is actually accepted and returned downstream. Vision can
        // produce a quadrilateral here that `isPlausibleCardCrop`
        // rejects as sub-card noise (e.g., 112×116 inside a full-art
        // card); attaching that rejected region's geometry to the
        // center-crop fallback would corrupt Mode 8 data. Clear up
        // front, then write the diagnostic only on the accepted path.
        engine.lastPerspectiveCorrection = nil
        let detectT0 = Date()
        let detection = engine.detectAndCrop(fullImage)
        let detectMs = Date().timeIntervalSince(detectT0) * 1000
        if let detection, Self.isPlausibleCardCrop(detection.image) {
            engine.lastPerspectiveCorrection = detection.perspectiveCorrection
            Logger.scan.debug("tap_detect: hit=true ms=\(String(format: "%.1f", detectMs)) size=\(Int(detection.image.size.width))x\(Int(detection.image.size.height))")
            return detection.image
        }
        if let detection {
            Logger.scan.debug("tap_detect: rejected sub-card crop \(Int(detection.image.size.width))x\(Int(detection.image.size.height)) ms=\(String(format: "%.1f", detectMs)) — falling back to center-crop")
        } else {
            Logger.scan.debug("tap_detect: hit=false ms=\(String(format: "%.1f", detectMs))")
        }

        // Tier 2 — center-crop fallback. Only fires when Vision can't
        // lock on a rectangle.
        let cardAspectRatio: CGFloat = 2.5 / 3.5
        let scale: CGFloat = 0.85
        let maxCardHeightFromHeight = extent.height * scale
        let maxCardHeightFromWidth = (extent.width * scale) / cardAspectRatio
        let cardHeight = min(maxCardHeightFromHeight, maxCardHeightFromWidth)
        let cardWidth = cardHeight * cardAspectRatio
        let cropRect = CGRect(
            x: extent.midX - cardWidth / 2,
            y: extent.midY - cardHeight / 2,
            width: cardWidth,
            height: cardHeight,
        )
        let cropped = ci.cropped(to: cropRect)
        guard let cg = frameRenderContext.createCGImage(cropped, from: cropRect) else {
            // If the center-crop fails too, return the full frame
            // rather than nil — better to scan something than nothing.
            return fullImage
        }
        return UIImage(cgImage: cg)
    }

    /// Sanity check for `engine.detectAndCrop` results: a real Pokémon
    /// card crop should fill enough of the viewfinder that the short
    /// side is hundreds of pixels (not 100ish) AND the aspect ratio
    /// should be portrait-card-like (Pokémon cards are 2.5×3.5 in =
    /// 0.714, with perspective distortion stretching this to 0.55–0.95).
    /// Anything outside these bounds is Vision locking onto a
    /// sub-card feature: a card-icon shape, a glare patch, a
    /// rules-text rectangle inside the artwork. Returning nil from
    /// this function makes captureCurrentFrame fall through to the
    /// center-crop fallback which sees the actual card.
    static func isPlausibleCardCrop(_ image: UIImage) -> Bool {
        let w = image.size.width
        let h = image.size.height
        let shortSide = min(w, h)
        let longSide = max(w, h)
        guard shortSide >= 300 else { return false }
        let aspect = shortSide / longSide
        guard aspect >= 0.55 && aspect <= 0.95 else { return false }
        return true
    }

    private func interfaceRotationAngle() -> CGFloat {
        guard let sceneOrientation = view.window?.windowScene?.interfaceOrientation else {
            return 90
        }

        switch sceneOrientation {
        case .portrait:
            return 90
        case .portraitUpsideDown:
            return 270
        case .landscapeLeft:
            return 0
        case .landscapeRight:
            return 180
        default:
            return 90
        }
    }

    private func cgImageOrientation(for videoRotationAngle: CGFloat) -> CGImagePropertyOrientation {
        let normalizedAngle = normalizedRotationAngle(videoRotationAngle)

        switch cameraPosition {
        case .back where normalizedAngle == 90:
            return .right
        case .back where normalizedAngle == 270:
            return .left
        case .back where normalizedAngle == 0:
            return .up
        case .back where normalizedAngle == 180:
            return .down
        case .front where normalizedAngle == 90:
            return .leftMirrored
        case .front where normalizedAngle == 270:
            return .rightMirrored
        case .front where normalizedAngle == 0:
            return .downMirrored
        case .front where normalizedAngle == 180:
            return .upMirrored
        case .back, .front, .unspecified:
            return .right
        @unknown default:
            return .right
        }
    }

    private func normalizedRotationAngle(_ angle: CGFloat) -> Int {
        let normalized = Int(angle.rounded()) % 360
        return normalized >= 0 ? normalized : normalized + 360
    }
}

private final class CameraPreviewView: UIView {
    override class var layerClass: AnyClass {
        AVCaptureVideoPreviewLayer.self
    }

    // Optional rather than fatalError: the `layerClass` override above
    // guarantees the cast in practice, but a degraded (black) preview is
    // recoverable for the user where a crash in the scanner is not.
    var previewLayer: AVCaptureVideoPreviewLayer? {
        layer as? AVCaptureVideoPreviewLayer
    }
}
