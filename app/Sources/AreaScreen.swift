import PhotosUI
import SwiftUI

/// The first screen: take or choose a photo, draw a closed shape on it with a finger, send it, wait, and open the result.
struct AreaScreen: View {
    @AppStorage("serviceAddress") private var serviceAddress = ""
    @AppStorage("accessWord") private var accessWord = ""

    /// The grid the shape snaps to, in photo pixels.
    private static let cell = 16
    /// The long side a photo is drawn at.
    private static let stageLongSide = 2600
    /// How long this screen waits for one job, in seconds.
    private static let waitLimit: TimeInterval = 600
    /// How many failed checks in a row, one second apart, before it stops asking.
    private static let failedChecksLimit = 10

    @State private var pick: PhotosPickerItem?
    @State private var source: UIImage?
    @State private var photo: PreparedPhoto?
    @State private var problem: String?
    // The finger's line, in photo pixels. The shape is worked out from it.
    @State private var stroke: [CGPoint] = []
    @State private var drawing = false
    /// True while a finger is down. It goes false by itself even when the system cuts a touch off.
    @GestureState private var touching = false
    @State private var shape: PenShape?
    @State private var running = false
    @State private var progress: String?
    @State private var finished: FinishedJob?
    @State private var jobTask: Task<Void, Never>?
    @State private var showCamera = false

    /// A finished job, for the result screen.
    private struct FinishedJob: Identifiable {
        let id: String
        let client: ServiceClient
        let result: JobResult
        let boxes: [GridBox]
        let cell: Int
        let width: Int
        let height: Int
    }

    private var serviceURL: URL? { ServiceClient.address(fromSettings: serviceAddress) }

    /// A photo that could not be read. Nothing shows when nothing went wrong.
    private var boxLine: String? { photo == nil ? problem : nil }

    var body: some View {
        VStack(spacing: 12) {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take a photo") { showCamera = true }
                    .disabled(running)
            }
            PhotosPicker("Choose a sample photo", selection: $pick, matching: .images)
                .disabled(running)
            Spacer(minLength: 0)
            if let photo {
                canvas(photo)
            }
            Spacer(minLength: 0)
            if let boxLine {
                Text(boxLine)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("boxLine")
            }
            sendArea
            settings
        }
        .padding(16)
        .task(id: pick) { await load() }
        .onChange(of: touching) {
            // A touch that is cut off gets no end call, and the next line must not join this one.
            if !touching { endLine() }
        }
        .sheet(item: $finished) { job in
            ResultScreen(client: job.client, jobID: job.id, result: job.result, boxes: job.boxes, cell: job.cell,
                         width: job.width, height: job.height) {
                startOver()
            }
            // Only "Start over" closes the result, so the photo goes with it.
            .interactiveDismissDisabled()
        }
        .fullScreenCover(isPresented: $showCamera) {
            SystemCamera { image in
                showCamera = false
                if let image {
                    // So the picker can load the same photo again later.
                    pick = nil
                    use(image)
                }
            }
            .ignoresSafeArea()
        }
    }

    private var sendArea: some View {
        VStack(spacing: 8) {
            HStack {
                if running {
                    Button("Stop waiting") { jobTask?.cancel() }
                } else {
                    Button("Clear") { clearShape() }
                        .disabled(shape == nil)
                }
                Spacer()
                Button("Blank this area") { startJob() }
                    .buttonStyle(.borderedProminent)
                    .disabled(shape == nil || running || serviceURL == nil)
            }
            if let progress {
                Text(progress)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("progress")
            }
        }
    }

    private var settings: some View {
        DisclosureGroup("Settings") {
            VStack(spacing: 8) {
                TextField("Service address", text: $serviceAddress)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("Access word", text: $accessWord)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.top, 8)
            .disabled(running)
        }
    }

    /// The photo, the area that takes the finger, and the finger's line on top.
    private func canvas(_ photo: PreparedPhoto) -> some View {
        Image(uiImage: photo.image)
            .resizable()
            .scaledToFit()
            .accessibilityIdentifier("photo")
            .overlay {
                GeometryReader { view in
                    let scale = view.size.width / CGFloat(max(photo.width, 1))
                    ZStack(alignment: .topLeading) {
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(DragGesture(minimumDistance: 0)
                                .updating($touching) { _, down, _ in down = true }
                                .onChanged { drag in
                                    guard !running else { return }
                                    if !drawing {
                                        clearShape()
                                        drawing = true
                                    }
                                    stroke.append(CGPoint(x: drag.location.x / scale, y: drag.location.y / scale))
                                }
                                .onEnded { _ in endLine() })
                        if !stroke.isEmpty {
                            Path { $0.addLines(stroke.map { CGPoint(x: $0.x * scale, y: $0.y * scale) }) }
                                .stroke(.yellow, lineWidth: 2)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
    }

    private func endLine() {
        guard drawing else { return }
        drawing = false
        finishShape()
    }

    /// After a result the photo goes too, so a second area of one photo is not one drag away.
    private func startOver() {
        finished = nil
        clearShape()
        source = nil
        photo = nil
        pick = nil
        problem = nil
    }

    /// The finger has lifted: its line closes and its cells are worked out.
    private func finishShape() {
        guard let photo, !stroke.isEmpty else { return }
        shape = PenShape.make(path: stroke, photoWidth: photo.width, photoHeight: photo.height, cell: Self.cell)
    }

    private func clearShape() {
        stroke = []
        drawing = false
        shape = nil
        progress = nil
    }

    private func load() async {
        guard let pick else { return }
        clearShape()
        source = nil
        photo = nil
        problem = nil
        let data = try? await pick.loadTransferable(type: Data.self)
        if let image = data.flatMap({ UIImage(data: $0) }) {
            use(image)
        } else {
            problem = "Could not read this photo."
        }
    }

    /// A new photo, from the picker or the camera.
    private func use(_ image: UIImage) {
        clearShape()
        source = image
        prepare()
        problem = photo == nil ? "Could not read this photo." : nil
    }

    private func prepare() {
        photo = source.flatMap {
            PreparedPhoto.make(from: $0, longSide: Self.stageLongSide, cell: Self.cell)
        }
    }

    private func startJob() {
        guard let photo, let shape, let serviceURL else { return }
        running = true
        jobTask = Task {
            let client = ServiceClient(base: serviceURL, word: ServiceClient.accessWord(fromSettings: accessWord))
            progress = await runJob(client, photo: photo, boxes: shape.boxes)
            running = false
            jobTask = nil
        }
    }

    /// Sends the photo and waits for the job to end. Returns the line to show, or nil when the result opens.
    private func runJob(_ client: ServiceClient, photo: PreparedPhoto, boxes: [GridBox]) async -> String? {
        let stopped = "Stopped waiting. The server may still be working, so the next send can say it is busy."
        progress = "Sending."
        let id: String
        do {
            id = try await client.seal(jpeg: photo.jpeg, boxes: boxes)
        } catch ServiceError.refused(let reason) {
            return sentence(forReason: reason)
        } catch {
            return Task.isCancelled ? stopped : "Could not reach the service."
        }
        let started = Date()
        var failedChecks = 0
        while !Task.isCancelled {
            let seconds = Date().timeIntervalSince(started)
            if seconds > Self.waitLimit {
                return "This took too long, so the screen stopped waiting. The server may still be working."
            }
            do {
                let job = try await client.job(id: id)
                failedChecks = 0
                switch job.state {
                case "queued", "running":
                    progress = "Working: \(Int(seconds)) s"
                case "done":
                    guard let result = JobResult(job: job, boxes: boxes, width: photo.width, height: photo.height) else {
                        return "The answer does not match what was sent, so no result is shown."
                    }
                    finished = FinishedJob(id: id, client: client, result: result, boxes: boxes, cell: Self.cell,
                                           width: photo.width, height: photo.height)
                    return nil
                default:
                    return sentence(forReason: job.reason ?? "failed")
                }
            } catch ServiceError.refused(let reason) {
                return sentence(forReason: reason)
            } catch {
                failedChecks += 1
                if failedChecks >= Self.failedChecksLimit, !Task.isCancelled {
                    return "Could not reach the service. The job may still be running."
                }
            }
            try? await Task.sleep(for: .seconds(1))
        }
        return stopped
    }
}
