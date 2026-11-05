import SwiftUI

/// What a finished job can honestly say. It exists only if the answer is exactly what was
/// asked for, and each sentence is chosen from a fixed list by the answer's words.
struct JobResult {
    let lines: [String]
    let hash: String

    init?(job: ServiceJob, box: GridBox, width: Int, height: Int) {
        guard job.state == "done", job.edit == "blank", job.check == "OK",
              job.areas == [[box.x, box.y, box.width, box.height]],
              job.width == width, job.height == height,
              let hash = job.sha256, hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }),
              job.seal_signer == "not-on-a-trust-list" else { return nil }
        let signer: String
        switch job.origin {
        case "demo-certificate":
            signer = "Signed by our demo certificate, on our Mac, after the app sent the photo. "
                + "It is not on any trust list. It does not show that a camera took this photo."
        case "trust-list":
            signer = "Signer of the original: on the C2PA trust list."
        case "other-signer":
            signer = "Signer of the original: not on a trust list."
        default:
            return nil
        }
        self.hash = hash
        lines = [
            "Edit: blank. Check: OK.",
            "Blanked: \(box.width) x \(box.height) at \(box.x), \(box.y).",
            "Our private server checked the proof: this picture follows from a signed original by the stated change. "
                + "You cannot check this step yourself. Prototype, not audited.",
            "The proof shows that only this area was blanked and the rest comes from the signed original; "
                + "it is not a privacy guarantee, because the file still carries a map of the hidden area, "
                + "which can show outlines, even writing on plain paper, and the original's hash.",
            signer,
            "Seal signer: not on a trust list.",
            "This screen shows a plain copy of the picture. The sealed file stays on our server and cannot be downloaded.",
            "The hash below names the sealed file, not this copy. This phone cannot check it.",
        ]
    }
}

/// The result: the picture, and the words beside it, all at the same size. It has no save or share button.
struct ResultScreen: View {
    let client: ServiceClient
    let jobID: String
    let result: JobResult
    let width: Int
    let height: Int
    let onDone: () -> Void

    @State private var picture: UIImage?
    @State private var problem = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let picture {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .accessibilityIdentifier("resultPicture")
                } else if problem {
                    Text("The picture could not be shown.")
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
                ForEach(result.lines, id: \.self) { Text($0) }
                Text("Hash of the sealed file: \(result.hash)")
                    .font(.body.monospaced())
                Button("Start over") { onDone() }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
            }
            .padding(16)
        }
        .task { await load() }
    }

    private func load() async {
        let data = try? await client.picture(id: jobID)
        // The picture must be the size of the photo that was sent.
        if let image = data.flatMap({ UIImage(data: $0) }),
           Int(image.size.width * image.scale) == width, Int(image.size.height * image.scale) == height {
            picture = image
        } else {
            problem = true
        }
    }
}
