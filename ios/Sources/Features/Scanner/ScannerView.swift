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
    /// Held so `handleSubjectAreaChange` can re-anchor focus / exposure
    /// without round-tripping through `captureSession.inputs`.
    private var configuredDevice: AVCaptureDevice?
    /// Observer token from `NotificationCenter.default.addObserver`. Stored
    /// so we can remove it in `deinit` — leaks the observer otherwise.
    private var subjectAreaObserver: NSObjectProtocol?

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
        if let token = subjectAreaObserver {
            NotificationCenter.default.removeObserver(token)
        }
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
        Task { @MainActor [weak viewModel] in
            viewModel?.normalizedRectConverter = converter
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
            self.configuredDevice = device
            // Configure focus / exposure / white-balance for the scanner's
            // actual use case: a small, close-up, mostly-stationary card
            // ~10 inches from the lens. AVCapture's default focus mode is
            // optimized for general photography (mid- to far-range scenes),
            // which left the AF motor visibly hunting on close-up cards
            // pre-2026-05-03 ("I have to wave the phone around"). Setting
            // continuous AF + .near range restriction biases the motor
            // toward near depths so it locks within ~0.3-0.5s instead of
            // hunting to infinity and back.
            self.configureFocusAndExposure(on: device)
            // After the device has continuous monitoring enabled, subscribe
            // to subject-area-change notifications so we re-anchor AF/AE
            // when the scene shifts (e.g. user moves the card to a different
            // position on the table). Apple's documented pattern from
            // "AVCam: Building a Camera App."
            self.installSubjectAreaChangeObserver(for: device)

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
        // Required for `AVCaptureDeviceSubjectAreaDidChange` notifications
        // to fire — without this the camera doesn't even compute the
        // subject-area-changed signal.
        device.isSubjectAreaChangeMonitoringEnabled = true
    }

    /// Subscribes to subject-area-change notifications. When the scene
    /// shifts substantially (user moves the card, panel-light flickers,
    /// hand enters/exits frame), the camera's previous focus lock no
    /// longer represents reality. Apple's recommendation: reset focus
    /// and exposure points to the frame center and re-run continuous
    /// AF/AE. The card guide is visually centered, so center is also
    /// the right anchor for the scanner's UX.
    private func installSubjectAreaChangeObserver(for device: AVCaptureDevice) {
        if let existing = subjectAreaObserver {
            NotificationCenter.default.removeObserver(existing)
        }
        subjectAreaObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.subjectAreaDidChangeNotification,
            object: device,
            queue: nil
        ) { [weak self] _ in
            self?.sessionQueue.async {
                self?.handleSubjectAreaChange()
            }
        }
    }

    private func handleSubjectAreaChange() {
        guard let device = configuredDevice else { return }
        do {
            try device.lockForConfiguration()
        } catch {
            return
        }
        defer { device.unlockForConfiguration() }
        let center = CGPoint(x: 0.5, y: 0.5)
        if device.isFocusPointOfInterestSupported,
           device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusPointOfInterest = center
            device.focusMode = .continuousAutoFocus
        }
        if device.isExposurePointOfInterestSupported,
           device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposurePointOfInterest = center
            device.exposureMode = .continuousAutoExposure
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let orientation = cgImageOrientation(for: connection.videoRotationAngle)
        engine.process(sampleBuffer: sampleBuffer, orientation: orientation)
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
