import SwiftUI

/// An answer the app accepts. It exists only if the check passed and the answer is exactly what was asked for.
/// The result screen opens only with one, so nothing on it shows before a pass.
struct JobResult {
    let hash: String

    init?(job: ServiceJob, boxes: [GridBox], width: Int, height: Int) {
        guard job.state == "done", job.edit == "blank", job.check == "OK",
              job.areas == boxes.map({ [$0.x, $0.y, $0.width, $0.height] }),
              job.width == width, job.height == height,
              let hash = job.sha256, hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }),
              job.seal_signer == "not-on-a-trust-list",
              job.origin == "demo-certificate" else { return nil }
        self.hash = hash
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
    @State private var sheet = AuthoriseSheet()
    @State private var authorising = Authorising.notYet
    @State private var picture: UIImage?
    @State private var problem = false

    private enum Authorising { case notYet, waiting, notAuthorised, authorised }

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
                    case .waiting:
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    case .notYet, .notAuthorised:
                        Button { authorise(link) } label: {
                            Theme.mainLabel(Text("Authorise this seal"))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        if authorising == .notAuthorised {
                            Text("Not authorised")
                                .font(Theme.text(15))
                                .frame(maxWidth: .infinity)
                                .accessibilityIdentifier("notAuthorised")
                        }
                    }
                }
                Button { onDone() } label: {
                    Text("Start over")
                        .font(Theme.text(15, .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(16)
        }
        .task { await load() }
    }

    /// The page's way back is only a hint. The word shows only after the web side answers with a record for this seal.
    private func authorise(_ link: URL) {
        authorising = .waiting
        Task {
            let back = await sheet.open(link)
            guard AuthoriseLink.saysAuthorised(back, hash: result.hash),
                  await AuthoriseLink.hasRecord(base: AuthoriseLink.base(fromSettings: webAddress), hash: result.hash) else {
                authorising = .notAuthorised
                return
            }
            authorising = .authorised
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
