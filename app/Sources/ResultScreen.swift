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

/// The result: the picture with its tiles. It has no save or share button.
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
    @Environment(\.openURL) private var openURL
    @State private var picture: UIImage?
    @State private var problem = false

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
                                                                edit: "blank", width: width, height: height) {
                    Button { openURL(link) } label: {
                        Theme.mainLabel(Text("Authorise this seal"))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
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

    private func load() async {
        let data = try? await client.picture(id: jobID)
        // The picture must be the size of the photo that was sent.
        guard let image = data.flatMap({ UIImage(data: $0) }),
              Int(image.size.width * image.scale) == width, Int(image.size.height * image.scale) == height else {
            problem = true
            return
        }
        // Drawn away from the screen's own thread, so a large picture does not stop the screen.
        let (areas, size) = (boxes, cell)
        let shown = await Task.detached(priority: .userInitiated) {
            AreaPreview.mosaic(image, boxes: areas, cell: size)
        }.value
        if let shown {
            picture = shown
        } else {
            problem = true
        }
    }
}
