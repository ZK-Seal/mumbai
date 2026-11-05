import PhotosUI
import SwiftUI

/// The first screen: choose a photo, draw a box on it with a finger, send it, wait, and open the result.
struct AreaScreen: View {
    /// The grid the box snaps to, in photo pixels.
    @AppStorage("cellSize") private var cellSize = 16
    @AppStorage("fullSize") private var fullSize = false
    @AppStorage("serviceAddress") private var serviceAddress = ""

    /// The long side a photo is drawn at, unless the Full size setting is on.
    private static let stageLongSide = 1600
    /// How long this screen waits for one job, in seconds.
    private static let waitLimit: TimeInterval = 600
    /// How many failed checks in a row, one second apart, before it stops asking.
    private static let failedChecksLimit = 10

    @State private var pick: PhotosPickerItem?
    @State private var source: UIImage?
    @State private var photo: PreparedPhoto?
    @State private var problem: String?
    // The finger's two points, in photo pixels. The box is worked out from them, so it follows the cell size.
    @State private var start: CGPoint?
    @State private var end: CGPoint?
    @State private var running = false
    @State private var progress: String?
    @State private var finished: FinishedJob?
    @State private var jobTask: Task<Void, Never>?

    /// A finished job, for the result screen.
    private struct FinishedJob: Identifiable {
        let id: String
        let client: ServiceClient
        let result: JobResult
        let width: Int
        let height: Int
    }

    private var box: GridBox? {
        guard let start, let end, let photo else { return nil }
        return GridBox.snapped(from: start, to: end, photoWidth: photo.width, photoHeight: photo.height, cell: cellSize)
    }

    private var serviceURL: URL? { ServiceClient.address(fromSettings: serviceAddress) }

    private var boxLine: String {
        guard let photo else { return problem ?? "No photo yet." }
        guard let box else { return "Draw a box on the photo with a finger." }
        return "Box: \(box.width) x \(box.height) at \(box.x), \(box.y) in a \(photo.width) x \(photo.height) photo"
    }

    var body: some View {
        VStack(spacing: 12) {
            PhotosPicker("Choose a sample photo", selection: $pick, matching: .images)
                .disabled(running)
            Spacer(minLength: 0)
            if let photo {
                canvas(photo)
            }
            Spacer(minLength: 0)
            Text(boxLine)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("boxLine")
            sendArea
            settings
        }
        .padding(16)
        .task(id: pick) { await load() }
        .onChange(of: cellSize) {
            progress = nil
            prepare()
        }
        .onChange(of: fullSize) {
            clearBox()
            prepare()
        }
        .sheet(item: $finished) { job in
            ResultScreen(client: job.client, jobID: job.id, result: job.result, width: job.width, height: job.height) {
                finished = nil
                clearBox()
            }
            // The words must stay with the result, so only "Start over" closes it.
            .interactiveDismissDisabled()
        }
    }

    private var sendArea: some View {
        VStack(spacing: 8) {
            if box != nil {
                Text("This photo goes to our server for the proof check.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
            HStack {
                if running {
                    Button("Stop waiting") { jobTask?.cancel() }
                } else {
                    Button("Clear box") { clearBox() }
                        .disabled(box == nil)
                }
                Spacer()
                Button("Blank this area") { startJob() }
                    .buttonStyle(.borderedProminent)
                    .disabled(box == nil || running || serviceURL == nil)
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
                Toggle("Full size", isOn: $fullSize)
                Stepper("Cell size: \(cellSize) px", value: $cellSize, in: 8...64, step: 8)
            }
            .padding(.top, 8)
            .disabled(running)
        }
    }

    /// The photo, the area that takes the finger, and the box on top.
    private func canvas(_ photo: PreparedPhoto) -> some View {
        Image(uiImage: photo.image)
            .resizable()
            .scaledToFit()
            .overlay {
                GeometryReader { view in
                    let pixelsPerPoint = CGFloat(photo.width) / max(view.size.width, 1)
                    ZStack(alignment: .topLeading) {
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                                guard !running else { return }
                                start = CGPoint(x: drag.startLocation.x * pixelsPerPoint, y: drag.startLocation.y * pixelsPerPoint)
                                end = CGPoint(x: drag.location.x * pixelsPerPoint, y: drag.location.y * pixelsPerPoint)
                                progress = nil
                            })
                        if let box {
                            Rectangle()
                                .fill(.black.opacity(0.35))
                                .overlay(Rectangle().stroke(.yellow, lineWidth: 2))
                                .frame(width: CGFloat(box.width) / pixelsPerPoint, height: CGFloat(box.height) / pixelsPerPoint)
                                .offset(x: CGFloat(box.x) / pixelsPerPoint, y: CGFloat(box.y) / pixelsPerPoint)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
            .accessibilityIdentifier("photo")
    }

    private func clearBox() {
        start = nil
        end = nil
        progress = nil
    }

    private func load() async {
        guard let pick else { return }
        clearBox()
        source = nil
        photo = nil
        problem = nil
        let data = try? await pick.loadTransferable(type: Data.self)
        source = data.flatMap { UIImage(data: $0) }
        prepare()
        if photo == nil {
            problem = "Could not read this photo."
        }
    }

    private func prepare() {
        photo = source.flatMap {
            PreparedPhoto.make(from: $0, longSide: fullSize ? nil : Self.stageLongSide, cell: cellSize)
        }
    }

    private func startJob() {
        guard let photo, let box, let serviceURL else { return }
        running = true
        jobTask = Task {
            progress = await runJob(ServiceClient(base: serviceURL), photo: photo, box: box)
            running = false
            jobTask = nil
        }
    }

    /// Sends the photo and waits for the job to end. Returns the line to show, or nil when the result opens.
    private func runJob(_ client: ServiceClient, photo: PreparedPhoto, box: GridBox) async -> String? {
        let stopped = "Stopped waiting. The server may still be working, so the next send can say it is busy."
        progress = "Sending."
        let id: String
        do {
            id = try await client.seal(jpeg: photo.jpeg, box: box)
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
                    guard let result = JobResult(job: job, box: box, width: photo.width, height: photo.height) else {
                        return "The answer does not match what was sent, so no result is shown."
                    }
                    finished = FinishedJob(id: id, client: client, result: result, width: photo.width, height: photo.height)
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
