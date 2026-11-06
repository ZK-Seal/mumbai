import SwiftUI

/// An answer the app accepts. It exists only if the check passed and the answer is exactly what was asked for.
/// The result screen opens only with one, so nothing on it shows before a pass.
struct JobResult {
    let hash: String
    /// The service's word that it checked this hash. It goes to the web side with this seal's calls.
    let ticket: String?

    init?(job: ServiceJob, boxes: [GridBox], width: Int, height: Int) {
        guard job.state == "done", job.edit == "blank", job.check == "OK",
              job.areas == boxes.map({ [$0.x, $0.y, $0.width, $0.height] }),
              job.width == width, job.height == height,
              let hash = job.sha256, hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }),
              job.seal_signer == "not-on-a-trust-list",
              job.origin == "demo-certificate" else { return nil }
        self.hash = hash
        ticket = job.ticket.flatMap { value in
            value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) } ? value : nil
        }
    }
}

/// The result: the picture with its cover. It has no save or share button.
struct ResultScreen: View {
    let client: ServiceClient
    let jobID: String
    let result: JobResult
    let boxes: [GridBox]
    let cell: Int
    let width: Int
    let height: Int
    let onDone: () -> Void

    @AppStorage("webAddress") private var webAddress = ""
    @AppStorage("cover") private var cover = Cover.mask
    @AppStorage("event") private var event = ""
    @AppStorage("userName") private var userName = ""
    @AppStorage("userLabel") private var userLabel = ""
    @AppStorage("userNameState") private var userNameState = ""
    @AppStorage("userSession") private var userSession = ""
    /// The SHA-256 of the badge scanned for one event. The code itself is never kept.
    @AppStorage("entryHash") private var entryHash = ""
    @AppStorage("entryEvent") private var entryEvent = ""
    @State private var showScan = false
    @State private var afterScan: URL?
    @State private var showNameStep = false
    @State private var afterName: URL?
    @State private var imageName: ImageName?
    @State private var imageWatch: Task<Void, Never>?
    @State private var sheet = AuthoriseSheet()
    @State private var world = WorldStep()
    @State private var authorising = Authorising.notYet
    @State private var failureWord: String?
    /// The web side's own words for a refusal, shown as they are.
    @State private var failureText: String?
    @State private var pictureToken: String?
    @State private var sending = Sending.none
    @State private var picture: UIImage?
    @State private var problem = false

    private enum Authorising { case notYet, waiting, notAuthorised, authorised }
    private enum Sending { case none, sending, failed }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let picture {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
                        .accessibilityIdentifier("resultPicture")
                } else if problem {
                    Text("The picture could not be shown.")
                        .font(Theme.text(15))
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
                Button { onDone() } label: {
                    Text("Start over")
                        .font(Theme.text(15, .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                if picture != nil, let link = AuthoriseLink.url(base: AuthoriseLink.base(fromSettings: webAddress), hash: result.hash,
                                                                edit: "blank", width: width, height: height,
                                                                event: AuthoriseLink.event(fromSettings: event)) {
                    switch authorising {
                    case .authorised:
                        Text("Authorised")
                            .font(Theme.text(17, .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .accessibilityIdentifier("authorised")
                        if imageName?.state == "done", let name = imageName?.name {
                            Text(name)
                                .font(Theme.text(14))
                                .multilineTextAlignment(.center)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity)
                                .accessibilityIdentifier("imageName")
                        } else if imageName?.state == "pending" {
                            Text("name being created")
                                .font(Theme.text(14))
                                .foregroundStyle(Theme.muted)
                                .frame(maxWidth: .infinity)
                        }
                        switch sending {
                        case .none:
                            EmptyView()
                        case .sending:
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        case .failed:
                            HStack {
                                Text("The picture was not sent.")
                                    .font(Theme.text(14))
                                    .foregroundStyle(.secondary)
                                Button("Try again") { sendPicture() }
                                    .font(Theme.text(14))
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                            }
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("pictureNotSent")
                        }
                    case .waiting:
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    case .notYet, .notAuthorised:
                        EventChooser()
                        Button { pressPublish(link) } label: {
                            Theme.mainLabel(Text("Publish on \(Names.root)"))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("publish")
                        if authorising == .notAuthorised {
                            Text(failureText ?? failureWord.map { "Not authorised: \($0)" } ?? "Not authorised")
                                .font(Theme.text(15))
                                .frame(maxWidth: .infinity)
                                .accessibilityIdentifier("notAuthorised")
                        }
                    }
                    // The name the web side gave, as it gave it.
                    if authorising != .notYet, !userName.isEmpty, Names.isSession(userSession) {
                        Text(userNameState == "pending" ? "\(userName): being created" : userName)
                            .font(Theme.text(14))
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("userName")
                    }
                }
            }
            .padding(16)
        }
        .task { await load() }
        .task(id: userName) { await watchUserName() }
        .onDisappear {
            world.stop()
            imageWatch?.cancel()
        }
        .sheet(isPresented: $showScan, onDismiss: {
            if let link = afterScan {
                afterScan = nil
                if entryNow != nil { authorise(link) }
            }
        }) {
            BadgeScanScreen(onHash: { hash in
                entryHash = hash
                entryEvent = AuthoriseLink.event(fromSettings: event) ?? ""
                showScan = false
            }, onClose: { showScan = false })
        }
        .sheet(isPresented: $showNameStep, onDismiss: {
            if let link = afterName {
                afterName = nil
                // Closed with no name: back to the button, and nothing is sent.
                if !userName.isEmpty { goOn(link) }
            }
        }) {
            NavigationStack {
                NameScreen { showNameStep = false }
            }
            .tint(Theme.accent)
            .presentationBackground(Theme.background)
        }
    }

    /// The badge's hash for the event now set, if one was scanned.
    private var entryNow: String? {
        guard let slug = AuthoriseLink.event(fromSettings: event), entryEvent == slug, !entryHash.isEmpty else { return nil }
        return entryHash
    }

    /// A photo going to an event needs a badge scanned for it first, before its World step. Closing the camera goes back to the button.
    private func goOn(_ link: URL) {
        guard AuthoriseLink.event(fromSettings: event) != nil, entryNow == nil else {
            authorise(link)
            return
        }
        afterScan = link
        showScan = true
    }

    /// Publish, in this order: the nickname and its World step if the person has no name yet, then the badge if the event needs one, then the photo. With a session the photo needs no second World trip. With none it has its own World step.
    private func pressPublish(_ link: URL) {
        guard userName.isEmpty else {
            goOn(link)
            return
        }
        afterName = link
        showNameStep = true
    }

    /// With a session, straight to the web side. With none, first the World app, with no page between.
    /// If the web side cannot be read or the World app cannot be opened, the page in a sheet does the same step.
    /// The page's way back is only a hint. The word shows only after the web side answers with a record for this seal.
    private func authorise(_ link: URL) {
        authorising = .waiting
        failureWord = nil
        failureText = nil
        let base = AuthoriseLink.base(fromSettings: webAddress)
        Task {
            switch await world.run(base: base, hash: result.hash, event: AuthoriseLink.event(fromSettings: event),
                                     session: Names.isSession(userSession) ? userSession : nil, ticket: result.ticket, entry: entryNow) {
            case .authorised(let token, let image):
                authorising = .authorised
                imageName = image
                pictureToken = token
                sendPicture()
                watchImage()
            case .notAuthorised:
                authorising = .notAuthorised
            case .worldFailed(let word):
                failureWord = word
                authorising = .notAuthorised
            case .refused(let text):
                failureText = text
                authorising = .notAuthorised
            case .sessionRefused(let text):
                // It will not become good. The next press goes on with no name, as any photo with no session does.
                userSession = ""
                failureWord = "session"
                failureText = text
                authorising = .notAuthorised
            case .noEntry:
                // The next press scans again.
                entryHash = ""
                failureWord = "no-entry"
                authorising = .notAuthorised
            case .useSheet:
                guard AuthoriseLink.sheetCanOpen(base: base) else {
                    authorising = .notAuthorised
                    return
                }
                let back = await sheet.open(link)
                guard AuthoriseLink.saysAuthorised(back, hash: result.hash), await AuthoriseLink.hasRecord(base: base, hash: result.hash) else {
                    authorising = .notAuthorised
                    return
                }
                authorising = .authorised
                watchImage()
            }
        }
    }

    /// Sends only the picture on this screen: the backend's plain copy with the cover flattened onto it.
    /// This screen never holds the photo from the phone or the sealed file. A failure does not change "Authorised".
    private func sendPicture() {
        guard let picture, let pictureToken else { return }
        sending = .sending
        let base = AuthoriseLink.base(fromSettings: webAddress)
        Task {
            let jpeg = await Task.detached(priority: .userInitiated) { PictureUpload.jpeg(from: picture) }.value
            if let jpeg, await PictureUpload.send(jpeg, base: base, hash: result.hash, token: pictureToken, ticket: result.ticket) {
                sending = .none
                // The web side names the image only after it keeps the picture.
                watchImage()
            } else {
                sending = .failed
            }
        }
    }

    /// The web side finishes a waiting name when it is asked, so this asks while the screen is open.
    private func watchUserName() async {
        guard userNameState == "pending", let label = Names.savedLabel(userLabel, name: userName) else { return }
        if let state = await Names.waitForName(base: AuthoriseLink.base(fromSettings: webAddress), label: label) {
            userNameState = state
        }
    }

    /// Asks for the image's ENS name until it is finished. It takes a while on the chain.
    /// A slow upload can use up the web side's time before the name is sent, so after about 90 s it asks for the name again.
    private func watchImage() {
        imageWatch?.cancel()
        let base = AuthoriseLink.base(fromSettings: webAddress)
        imageWatch = Task {
            var pendingSince: Date?
            for _ in 0..<60 {
                if let found = await Names.image(base: base, hash: result.hash) {
                    imageName = found
                    if found.state != "pending" { return }
                    let since = pendingSince ?? Date()
                    pendingSince = since
                    if Date().timeIntervalSince(since) >= 90, let pictureToken {
                        await PictureUpload.askForName(base: base, hash: result.hash, token: pictureToken, ticket: result.ticket)
                        pendingSince = Date()
                    }
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { return }
            }
        }
    }

    private func load() async {
        let data = try? await client.picture(id: jobID)
        // The picture must be the size of the photo that was sent.
        guard let image = data.flatMap({ UIImage(data: $0) }),
              Int(image.size.width * image.scale) == width, Int(image.size.height * image.scale) == height else {
            problem = true
            return
        }
        // Drawn away from the screen's own thread, so a large picture does not stop the screen.
        let (areas, size, chosen) = (boxes, cell, cover)
        let shown = await Task.detached(priority: .userInitiated) {
            AreaPreview.covered(image, boxes: areas, cell: size, cover: chosen)
        }.value
        if let shown {
            picture = shown
        } else {
            problem = true
        }
    }
}
