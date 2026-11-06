import AVFoundation
import CryptoKit
import SwiftUI

/// Reads an ETHGlobal badge's QR code with the camera. The code is plain unknown text, and it leads to a person's real name.
/// It is never kept, shown or logged. The phone follows it once, to see where it lands, and reads nothing of the page.
/// This screen passes on only its SHA-256.
struct BadgeScanScreen: View {
    let onHash: (String) -> Void
    let onClose: () -> Void

    @State private var allowed: Bool?
    @State private var line: String?
    @State private var checking = false
    /// The last code's hash, so a code still in view is checked once. It goes with this screen.
    @State private var lastHash: String?
    @State private var check: Task<Void, Never>?

    private static let notABadge = "This is not an ETHGlobal badge."

    private enum Landing { case real, notReal, noNetwork }

    var body: some View {
        NavigationStack {
            Group {
                if allowed == true {
                    CodeCamera { code in see(code) }
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .bottom) {
                        if checking {
                            ProgressView()
                                .padding(12)
                                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                                .padding(16)
                        } else if let line {
                            Text(line)
                                .font(Theme.text(15, .medium))
                                .foregroundStyle(Theme.refused)
                                .multilineTextAlignment(.center)
                                .padding(12)
                                .background(Theme.refusedBackground, in: RoundedRectangle(cornerRadius: 12))
                                .padding(16)
                                .accessibilityIdentifier("badgeLine")
                        }
                    }
                } else if allowed == false {
                    Text("The camera is off for this app. Turn it on in the iPhone's Settings, or clear the event in this app's Settings.")
                        .font(Theme.text(15))
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                        .padding(16)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationTitle("Scan your badge")
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
        .onDisappear { check?.cancel() }
    }

    /// One code seen by the camera. A code that passes goes on as its hash.
    private func see(_ code: String) {
        let hash = Self.hash(of: code)
        guard !checking, hash != lastHash else { return }
        lastHash = hash
        guard Self.isBadge(code) else {
            line = Self.notABadge
            return
        }
        line = nil
        checking = true
        check = Task {
            let landing = await Self.follow(code)
            // A person who closed this screen has said no, so a late answer does nothing.
            guard !Task.isCancelled else { return }
            checking = false
            switch landing {
            case .real:
                onHash(hash)
            case .notReal:
                line = Self.notABadge
            case .noNetwork:
                line = "The badge could not be checked. Check the network and try again."
                // A code still in view is tried again after a moment.
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if lastHash == hash { lastHash = nil }
            }
        }
    }

    /// Follows the link with a session that keeps nothing and sends no cookies. It reads only where the link ended, not the page.
    /// A real badge must land on a page under ethglobal.com. A made-up code lands on the site's front page.
    private static func follow(_ code: String) async -> Landing {
        guard let url = URL(string: code) else { return .notReal }
        let setup = URLSessionConfiguration.ephemeral
        setup.httpCookieStorage = nil
        setup.httpShouldSetCookies = false
        setup.httpCookieAcceptPolicy = .never
        setup.urlCache = nil
        setup.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        setup.timeoutIntervalForRequest = 15
        setup.timeoutIntervalForResource = 30
        let session = URLSession(configuration: setup)
        defer { session.invalidateAndCancel() }
        guard let (bytes, response) = try? await session.bytes(from: url), let landed = response.url else { return .noNetwork }
        bytes.task.cancel()
        guard landed.scheme?.lowercased() == "https", let host = landed.host?.lowercased(),
              host == "ethglobal.com" || host.hasSuffix(".ethglobal.com") else { return .notReal }
        return landed.path.isEmpty || landed.path == "/" ? .notReal : .real
    }

    /// Only an https link on the badge's short host, or on ethglobal.com or under it, with no user, password or port.
    private static func isBadge(_ code: String) -> Bool {
        guard let parts = URLComponents(string: code), parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased() else { return false }
        return host == "ethglob.al" || host == "ethglobal.com" || host.hasSuffix(".ethglobal.com")
    }

    /// Lowercase hex of the SHA-256 of the code's exact text, as UTF-8.
    private static func hash(of code: String) -> String {
        SHA256.hash(data: Data(code.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// The camera's picture. It hands on each QR code it sees.
private struct CodeCamera: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> Controller { Controller(onCode: onCode) }
    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let onCode: (String) -> Void
        private var preview: AVCaptureVideoPreviewLayer?

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
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, !code.isEmpty else { return }
            onCode(code)
        }
    }
}
