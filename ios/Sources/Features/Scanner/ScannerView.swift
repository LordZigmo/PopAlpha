import AVFoundation
import ImageIO
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

    override func loadView() {
        view = previewView
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        previewView.previewLayer.session = captureSession
        previewView.previewLayer.videoGravity = .resizeAspectFill

        configureCameraAccess()
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
        hasInstalledConverter = true
        let layer = previewView.previewLayer
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
        Task { @MainActor [weak viewModel] in
            viewModel?.normalizedRectConverter = converter
            viewModel?.frameCapturer = capturer
        }
    }

    func updatePreviewOrientation() {
        let rotationAngle = interfaceRotationAngle()

        if let previewConnection = previewView.previewLayer.connection,
           previewConnection.isVideoRotationAngleSupported(rotationAngle) {
            previewConnection.videoRotationAngle = rotationAngle
        }

        if let outputConnection = videoOutput.connection(with: .video),
           outputConnection.isVideoRotationAngleSupported(rotationAngle) {
            outputConnection.videoRotationAngle = rotationAngle
        }
    }

    private func configureCameraAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSessionIfNeeded()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard granted, let self else {
                    return
                }

                self.configureSessionIfNeeded()
                self.startSessionIfNeeded()
            }
        case .denied, .restricted:
            break
        @unknown default:
            break
        }
    }

    private func configureSessionIfNeeded() {
        sessionQueue.async {
            guard !self.isSessionConfigured else {
                return
            }

            self.captureSession.beginConfiguration()
            self.captureSession.sessionPreset = .high

            defer {
                self.captureSession.commitConfiguration()
            }

            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: self.cameraPosition),
                  let input = try? AVCaptureDeviceInput(device: device),
                  self.captureSession.canAddInput(input) else {
                return
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
                return
            }

            self.captureSession.addOutput(self.videoOutput)

            if let outputConnection = self.videoOutput.connection(with: .video) {
                outputConnection.videoRotationAngle = 0
            }

            self.isSessionConfigured = true

            DispatchQueue.main.async {
                self.updatePreviewOrientation()
            }
        }
    }

    private func startSessionIfNeeded() {
        sessionQueue.async {
            guard self.isSessionConfigured, !self.captureSession.isRunning else {
                return
            }

            self.captureSession.startRunning()
        }
    }

    private func stopSession() {
        sessionQueue.async {
            guard self.captureSession.isRunning else {
                return
            }

            self.captureSession.stopRunning()
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
            latestPixelBuffer = pixelBuffer
            latestPixelBufferOrientation = orientation
            latestFrameLock.unlock()
        }
        engine.process(sampleBuffer: sampleBuffer, orientation: orientation)
    }

    /// Snapshot the most recent video frame as a `UIImage`, cropped to
    /// a centered card-shaped region. Used by the scanner's manual
    /// capture button. Returns nil if the camera hasn't produced a
    /// frame yet (e.g., session is still warming up).
    ///
    /// Why the center crop matters: the auto-capture path uses Vision's
    /// rectangle detection to pull just the card region out of each
    /// frame. The shutter button bypasses Vision entirely, which means
    /// without a deliberate crop the embedder would see ~40% card +
    /// ~60% table / hand / background. SigLIP isn't a card classifier;
    /// background pixels pull the embedding off the card-content
    /// manifold. Real-device 2026-05-04: a Cinderace V scan via the
    /// shutter returned Umbreon V at top-1 (with 4 Cinderace variants
    /// at rank 2-5) because the messy background tilted the embedding
    /// toward "generic V card layout" rather than "Cinderace
    /// specifically."
    ///
    /// Crop math: portrait card aspect ratio (2.5/3.5 ≈ 0.714 w/h),
    /// sized to fill 85% of whichever frame dimension is the binding
    /// constraint, centered. Works regardless of whether the captured
    /// frame is portrait (~1080x1920) or landscape (~1920x1080) since
    /// the user might be on a device whose AVCaptureConnection rotates
    /// output buffers and might not.
    func captureCurrentFrame() -> UIImage? {
        latestFrameLock.lock()
        let pixelBuffer = latestPixelBuffer
        let orientation = latestPixelBufferOrientation
        latestFrameLock.unlock()
        guard let pixelBuffer else { return nil }
        let ci = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let extent = ci.extent
        guard extent.width > 0, extent.height > 0 else { return nil }

        // Card aspect ratio in portrait orientation (the natural way to
        // hold a Pokémon card). 2.5"/3.5" ≈ 0.714.
        let cardAspectRatio: CGFloat = 2.5 / 3.5
        let scale: CGFloat = 0.85
        // Maximum card-shape rectangle that fits in the frame. Picking
        // the binding-dimension lets us produce the SAME crop quality
        // regardless of whether the buffer arrived as portrait or
        // landscape.
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
            return nil
        }
        return UIImage(cgImage: cg)
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

    var previewLayer: AVCaptureVideoPreviewLayer {
        guard let layer = layer as? AVCaptureVideoPreviewLayer else {
            fatalError("Expected AVCaptureVideoPreviewLayer")
        }

        return layer
    }
}
