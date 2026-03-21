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
                    ScannerCameraPreview(engine: viewModel.visionEngine)
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
    let engine: PopAlphaVisionEngine

    func makeUIViewController(context: Context) -> ScannerCameraViewController {
        ScannerCameraViewController(engine: engine)
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
    private let engine: PopAlphaVisionEngine

    private var isSessionConfigured = false
    private let cameraPosition: AVCaptureDevice.Position = .back

    init(engine: PopAlphaVisionEngine) {
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
