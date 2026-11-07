import PhotosUI
import SwiftUI

/// The first screen: take or choose a photo, draw a closed shape on it with a finger, send it, wait, and open the result.
struct AreaScreen: View {
    @AppStorage("serviceAddress") private var serviceAddress = ""
    @AppStorage("accessWord") private var accessWord = ""
    @AppStorage("webAddress") private var webAddress = ""
    @AppStorage("siteAddress") private var siteAddress = ""
    @AppStorage("event") private var event = ""
    @AppStorage("cover") private var cover = Cover.mask
    @AppStorage("userName") private var userName = ""
    @AppStorage("userLabel") private var userLabel = ""

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
    /// How far the photo is zoomed and moved on the screen. Both only change the view, never a cell.
    @State private var zoom: CGFloat = 1
    @State private var pan = CGSize.zero
    /// Each closed line, in the order drawn.
    @State private var shapes: [PenShape] = []
    /// All of them as one. This is what is sent.
    @State private var shape: PenShape?
    @State private var still: UIImage?
    @State private var fresh: UIImage?
    @State private var freshAnchor = UnitPoint.center
    @State private var freshShown = false
    @State private var previewTask: Task<Void, Never>?
    @State private var running = false
    @State private var progress: String?
    @State private var finished: FinishedJob?
    @State private var jobTask: Task<Void, Never>?
    @State private var showCamera = false
    @State private var showSettings = false

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

    /// What stops a send before it starts, in plain words.
    private var missing: String? {
        if serviceURL == nil { return "No service address. Add it in Settings." }
        if ServiceClient.accessWord(fromSettings: accessWord).isEmpty { return "No access word. Add it in Settings." }
        return nil
    }

    /// A photo that could not be read. Nothing shows when nothing went wrong.
    private var boxLine: String? { photo == nil ? problem : nil }

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Spacer()
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.muted)
                }
                .accessibilityLabel("Settings")
                .disabled(running)
            }
            if let photo {
                photoChoices
                Spacer(minLength: 0)
                canvas(photo)
                Spacer(minLength: 0)
                sendArea
            } else {
                Spacer()
                Image("HomeLogo")
                    .resizable()
                    .frame(width: 144, height: 144)
                    .offset(y: -110)
                    .accessibilityLabel("")
                    .accessibilityIdentifier("homeLogo")
                if let boxLine {
                    Text(boxLine)
                        .font(Theme.text(15))
                        .foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("boxLine")
                }
                firstChoices
                Spacer()
            }
        }
        .padding(16)
        .background(Theme.background.ignoresSafeArea())
        .task(id: pick) { await load() }
        .onAppear { keepLaunchSettings() }
        .task { await refreshName() }
        .onChange(of: cover) { shapesChanged() }
        .sheet(item: $finished) { job in
            ResultScreen(client: job.client, jobID: job.id, result: job.result, boxes: job.boxes, cell: job.cell,
                         width: job.width, height: job.height) {
                startOver()
            }
            // Only "Start over" closes the result, so the photo goes with it.
            .interactiveDismissDisabled()
            .presentationBackground(Theme.background)
            .tint(Theme.accent)
        }
        .sheet(isPresented: $showSettings) { settings }
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

    /// With no photo: one main action, and a quiet second one.
    private var firstChoices: some View {
        VStack(spacing: 10) {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: {
                    Theme.mainLabel(Label("Take a photo", systemImage: "camera.fill"))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            PhotosPicker(selection: $pick, matching: .images) {
                Label("Choose a sample photo", systemImage: "photo")
                    .font(Theme.text(15))
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.top, 8)
    }

    /// With a photo: both ways to get another one, quietly.
    private var photoChoices: some View {
        HStack {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: {
                    Label("Take a photo", systemImage: "camera")
                }
            }
            Spacer()
            PhotosPicker(selection: $pick, matching: .images) {
                Label("Choose a sample photo", systemImage: "photo")
            }
        }
        .font(Theme.text(14))
        .foregroundStyle(Theme.muted)
        .disabled(running)
    }

    private var sendArea: some View {
        VStack(spacing: 10) {
            if let missing {
                Text(missing)
                    .font(Theme.text(13, .medium))
                    .foregroundStyle(Theme.refused)
                    .accessibilityIdentifier("missing")
            }
            HStack(spacing: 16) {
                if running {
                    Button("Stop waiting") { jobTask?.cancel() }
                        .foregroundStyle(Theme.muted)
                } else {
                    Button("Clear") { clearShape() }
                        .foregroundStyle(Theme.muted)
                        .disabled(shape == nil)
                    Button("Undo") { undoShape() }
                        .foregroundStyle(Theme.muted)
                        .disabled(shape == nil)
                }
                Button { startJob() } label: {
                    Theme.mainLabel(Text("Blank this area"))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(shape == nil || running || missing != nil)
            }
            .font(Theme.text(15))
            if let progress {
                Text(progress)
                    .font(Theme.text(13, .medium))
                    .foregroundStyle(running ? Theme.waiting : Theme.refused)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(running ? Theme.waitingBackground : Theme.refusedBackground, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("progress")
            }
        }
    }

    /// Everything a viewer does not need, behind one small icon.
    private var settings: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Service address", text: $serviceAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Access word", text: $accessWord)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Web address", text: $webAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Site address", text: $siteAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    EventChooser(plain: true)
                }
                .listRowBackground(Theme.surface)
                Section {
                    NavigationLink {
                        NameScreen()
                    } label: {
                        LabeledContent("Your name") {
                            Text(userName)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .accessibilityIdentifier("yourName")
                }
                .listRowBackground(Theme.surface)
                Section {
                    Picker("Cover", selection: $cover) {
                        Text("Mask").tag(Cover.mask)
                        Text("Mosaic").tag(Cover.mosaic)
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .font(Theme.text(15))
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = false } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .tint(Theme.accent)
        .presentationBackground(Theme.background)
        .task { await refreshName() }
    }

    /// The photo with its cover and the finger's line, which all zoom and move together, and the area that takes
    /// the fingers on top. The line shows only while the finger is down.
    private func canvas(_ photo: PreparedPhoto) -> some View {
        Image(uiImage: photo.image)
            .resizable()
            .scaledToFit()
            .overlay {
                if let still {
                    Image(uiImage: still).resizable()
                }
            }
            .overlay {
                if let fresh {
                    Image(uiImage: fresh)
                        .resizable()
                        .scaleEffect(freshShown ? 1 : 0.92, anchor: freshAnchor)
                        .opacity(freshShown ? 1 : 0)
                }
            }
            .overlay {
                GeometryReader { view in
                    let scale = view.size.width / CGFloat(max(photo.width, 1))
                    if drawing {
                        Path { $0.addLines(stroke.map { CGPoint(x: $0.x * scale, y: $0.y * scale) }) }
                            .stroke(.yellow, lineWidth: 2 / zoom)
                    }
                }
            }
            .scaleEffect(zoom, anchor: .topLeading)
            .offset(pan)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
            .accessibilityIdentifier("chosenPhoto")
            .overlay {
                GeometryReader { view in
                    let scale = view.size.width / CGFloat(max(photo.width, 1))
                    PhotoTouches(zoom: $zoom, pan: $pan, canDraw: !running,
                                 lineStarted: {
                                     stroke = []
                                     progress = nil
                                     drawing = true
                                 },
                                 linePoint: { stroke.append(CGPoint(x: $0.x / scale, y: $0.y / scale)) },
                                 lineEnded: { endLine() },
                                 lineDropped: {
                                     stroke = []
                                     drawing = false
                                 })
                }
            }
    }

    /// An address and word given at launch stay in the settings, so a restart does not lose them.
    private func keepLaunchSettings() {
        let given = ProcessInfo.processInfo.environment
        if let address = given["SERVICE_URL"], !address.isEmpty { serviceAddress = address }
        if let word = given["SERVICE_WORD"], !word.isEmpty { accessWord = word }
        if let web = given["WEB_URL"], !web.isEmpty { webAddress = web }
        if let site = given["SITE_URL"], !site.isEmpty { siteAddress = site }
        if let name = given["EVENT_SLUG"], !name.isEmpty { event = name }
    }

    /// The name the web side lists now, so a name saved on an earlier run does not stay.
    private func refreshName() async {
        let base = AuthoriseLink.base(fromSettings: webAddress)
        guard !base.isEmpty, let label = Names.savedLabel(userLabel, name: userName) else { return }
        if let found = await Names.listing(base: base, label: label), found.name != userName {
            userName = found.name
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
        zoom = 1
        pan = .zero
        clearShape()
        source = nil
        photo = nil
        pick = nil
        problem = nil
    }

    /// The finger has lifted: its line closes and its cells join the others. A line too small to hold a cell adds nothing.
    private func finishShape() {
        defer { stroke = [] }
        guard let photo, !stroke.isEmpty,
              PenShape.holdsACell(path: stroke, photoWidth: photo.width, photoHeight: photo.height, cell: Self.cell),
              let added = PenShape.make(path: stroke, photoWidth: photo.width, photoHeight: photo.height, cell: Self.cell) else { return }
        shapes.append(added)
        shapesChanged(newest: added)
    }

    private func undoShape() {
        guard !shapes.isEmpty else { return }
        shapes.removeLast()
        shapesChanged()
    }

    /// All the shapes as one. The look is drawn away from the screen's own thread, so a large photo does not
    /// stop the screen. A newer change replaces it. The newest shape's piece arrives softly.
    private func shapesChanged(newest: PenShape? = nil) {
        previewTask?.cancel()
        previewTask = nil
        progress = nil
        guard let photo else { return }
        shape = PenShape.joined(shapes, photoWidth: photo.width, photoHeight: photo.height, cell: Self.cell)
        guard let boxes = shape?.boxes else {
            still = nil
            fresh = nil
            return
        }
        let older = PenShape.joined(Array(shapes.dropLast()), photoWidth: photo.width, photoHeight: photo.height, cell: Self.cell)?.boxes ?? []
        let (image, cell, first, chosen) = (photo.image, Self.cell, newest?.boxes.first, cover)
        previewTask = Task.detached(priority: .userInitiated) {
            let drawn = AreaPreview.layers(image, boxes: boxes, older: older, newest: first, cell: cell, cover: chosen)
            await MainActor.run {
                guard !Task.isCancelled else { return }
                still = drawn?.still
                fresh = drawn?.fresh
                freshAnchor = drawn?.anchor ?? .center
                freshShown = false
                previewTask = nil
                // On the next turn, so the screen first draws it small and clear.
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.2)) { freshShown = true }
                }
            }
        }
    }

    private func clearShape() {
        previewTask?.cancel()
        previewTask = nil
        stroke = []
        drawing = false
        shapes = []
        shape = nil
        still = nil
        fresh = nil
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
        zoom = 1
        pan = .zero
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
                case "waiting":
                    progress = "Waiting for the server."
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
