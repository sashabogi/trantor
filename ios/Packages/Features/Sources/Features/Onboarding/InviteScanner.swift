@preconcurrency import AVFoundation
import SwiftUI
import TrantorDesign
import UIKit

struct InviteScanner: UIViewControllerRepresentable {
    var torch: Bool
    var onScan: @MainActor (String) -> Void
    var onFailure: @MainActor (String) -> Void
    var onTorchAvailable: @MainActor (Bool) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(onScan: onScan, onFailure: onFailure, onTorchAvailable: onTorchAvailable)
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.camera.setTorch(torch)
        controller.view.setNeedsLayout()
    }

    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) {
        controller.stop()
    }
}

final class ScannerController: UIViewController {
    let camera: ScannerCamera
    private let preview = AVCaptureVideoPreviewLayer()
    private let reticle = CAShapeLayer()
    private var visible = false
    private let onFailure: @MainActor (String) -> Void

    init(onScan: @escaping @MainActor (String) -> Void,
         onFailure: @escaping @MainActor (String) -> Void,
         onTorchAvailable: @escaping @MainActor (Bool) -> Void) {
        self.onFailure = onFailure
        camera = ScannerCamera(onScan: onScan, onFailure: onFailure, onTorchAvailable: onTorchAvailable)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.session = camera.session
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        reticle.fillColor = UIColor.clear.cgColor
        reticle.strokeColor = UIColor(Palette.accent).cgColor
        reticle.lineWidth = 3
        view.layer.addSublayer(reticle)
        view.accessibilityLabel = "Point the camera at your Trantor pairing QR code"
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        visible = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camera.start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self, self.visible else { return }
                    if granted { self.camera.start() }
                    else { self.onFailure("Camera access is off. Paste your invite link instead, or allow Camera in Settings.") }
                }
            }
        default: onFailure("Camera access is off. Paste your invite link instead, or allow Camera in Settings.")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
        let angle: CGFloat
        switch orientation {
        case .landscapeLeft: angle = 0
        case .landscapeRight: angle = 180
        case .portraitUpsideDown: angle = 270
        default: angle = 90
        }
        if let connection = preview.connection, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
        let side = min(view.bounds.width, view.bounds.height) * 0.7
        let frame = CGRect(x: view.bounds.midX - side / 2, y: view.bounds.midY - side / 2, width: side, height: side)
        reticle.path = UIBezierPath(roundedRect: frame, cornerRadius: 20).cgPath
        let region = preview.metadataOutputRectConverted(fromLayerRect: frame)
        camera.setRegion(region)
    }

    override func viewWillDisappear(_ animated: Bool) {
        stop()
        super.viewWillDisappear(animated)
    }

    func stop() { visible = false; camera.stop() }
}

// Capture configuration and delegate callbacks stay on one serial queue; UI callbacks hop to MainActor.
final class ScannerCamera: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.trantor.invite-camera")
    private let output = AVCaptureMetadataOutput()
    private var device: AVCaptureDevice?
    private var configured = false
    private var consumed = false
    private var region = CGRect(x: 0.15, y: 0.15, width: 0.7, height: 0.7)
    private var lastInvalid: String?
    private let onScan: @MainActor (String) -> Void
    private let onFailure: @MainActor (String) -> Void
    private let onTorchAvailable: @MainActor (Bool) -> Void

    init(onScan: @escaping @MainActor (String) -> Void,
         onFailure: @escaping @MainActor (String) -> Void,
         onTorchAvailable: @escaping @MainActor (Bool) -> Void) {
        self.onScan = onScan; self.onFailure = onFailure; self.onTorchAvailable = onTorchAvailable
    }

    func start() {
        queue.async { [self] in
            do {
                if !configured { try configure() }
                consumed = false
                if !session.isRunning { session.startRunning() }
                let hasTorch = device?.hasTorch == true
                Task { @MainActor in onTorchAvailable(hasTorch) }
            } catch {
                Task { @MainActor in onFailure("Could not start the camera. Paste your invite link instead.") }
            }
        }
    }

    private func configure() throws {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.unavailable
        }
        let input = try AVCaptureDeviceInput(device: camera)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
        guard session.canAddInput(input) else { throw CameraError.unavailable }
        session.addInput(input)
        guard session.canAddOutput(output) else { session.removeInput(input); throw CameraError.unavailable }
        session.addOutput(output)
        guard output.availableMetadataObjectTypes.contains(.qr) else {
            session.removeInput(input); session.removeOutput(output); throw CameraError.unavailable
        }
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: queue)
        output.rectOfInterest = region
        do {
            try camera.lockForConfiguration()
            defer { camera.unlockForConfiguration() }
            if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
            if camera.isAutoFocusRangeRestrictionSupported { camera.autoFocusRangeRestriction = .near }
            if camera.isExposureModeSupported(.continuousAutoExposure) { camera.exposureMode = .continuousAutoExposure }
            camera.setExposureTargetBias(max(camera.minExposureTargetBias, min(-1.5, camera.maxExposureTargetBias)))
            applyZoom(camera)
        } catch {
            session.removeInput(input); session.removeOutput(output)
            throw error
        }
        device = camera
        configured = true
    }

    private func applyZoom(_ camera: AVCaptureDevice) {
        camera.videoZoomFactor = CGFloat(ScannerOptics.zoom(
            minimumFocusDistance: Double(camera.minimumFocusDistance),
            fieldOfView: Double(camera.activeFormat.videoFieldOfView),
            reticleFraction: Double(region.width),
            minimumZoom: Double(camera.minAvailableVideoZoomFactor),
            maximumZoom: Double(camera.maxAvailableVideoZoomFactor)))
    }

    func setRegion(_ rect: CGRect) {
        guard rect.width > 0, rect.height > 0 else { return }
        queue.async { [self] in
            region = rect
            if configured { output.rectOfInterest = rect }
            guard let device else { return }
            do { try device.lockForConfiguration(); defer { device.unlockForConfiguration() }; applyZoom(device) }
            catch { /* Keep the last valid zoom while capture is busy. */ }
        }
    }

    func setTorch(_ enabled: Bool) {
        queue.async { [self] in
            guard let device, device.hasTorch, device.isTorchAvailable else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                device.torchMode = enabled ? .on : .off
            } catch {
                Task { @MainActor in onFailure("The torch is unavailable. You can still scan or paste the link.") }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            if let device, device.hasTorch, (try? device.lockForConfiguration()) != nil {
                device.torchMode = .off
                device.unlockForConfiguration()
            }
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !consumed else { return }
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects {
            guard let value = code.stringValue else { continue }
            guard InviteCode.parse(value) != nil else {
                if value != lastInvalid {
                    lastInvalid = value
                    Task { @MainActor in onFailure("That QR code is not a Trantor invite. Scan your hub's pairing code or paste its link.") }
                }
                continue
            }
            consumed = true
            if session.isRunning { session.stopRunning() }
            Task { @MainActor in onScan(value) }
            return
        }
    }

    private enum CameraError: Error { case unavailable }
}
