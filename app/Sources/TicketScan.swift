import AVFoundation
import CryptoKit
import SwiftUI

/// Reads a ticket's QR code with the camera. The code is plain unknown text.
/// It is never kept, shown or logged. This screen passes on only its SHA-256.
struct TicketScanScreen: View {
    let onHash: (String) -> Void
    let onClose: () -> Void

    @State private var allowed: Bool?

    var body: some View {
        NavigationStack {
            Group {
                if allowed == true {
                    CodeCamera { code in onHash(Self.hash(of: code)) }
                        .ignoresSafeArea(edges: .bottom)
                } else if allowed == false {
                    Text("The camera is not available.")
                        .font(Theme.text(15))
                        .foregroundStyle(Theme.muted)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationTitle("Scan your ticket")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { onClose() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .tint(Theme.accent)
        .presentationBackground(Theme.background)
        .task { allowed = await AVCaptureDevice.requestAccess(for: .video) }
    }

    /// Lowercase hex of the SHA-256 of the code's exact text, as UTF-8.
    private static func hash(of code: String) -> String {
        SHA256.hash(data: Data(code.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// The camera's picture, and the first QR code it sees.
private struct CodeCamera: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> Controller { Controller(onCode: onCode) }
    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let onCode: (String) -> Void
        private var preview: AVCaptureVideoPreviewLayer?
        private var done = false

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, !code.isEmpty else { return }
            done = true
            onCode(code)
        }
    }
}
