import SwiftUI

/// The person's short name. World proves one human, and the web side makes the name and finishes it in the background.
struct NameScreen: View {
    /// Set when this step comes before authorising. It then offers a way on.
    var onClose: (() -> Void)?

    @AppStorage("webAddress") private var webAddress = ""
    @AppStorage("userName") private var userName = ""
    @AppStorage("userNameState") private var userNameState = ""
    @AppStorage("userSession") private var userSession = ""
    @State private var label = ""
    @State private var working = false
    @State private var line: String?
    @State private var world = WorldStep()
    @State private var sheet = AuthoriseSheet()

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $label)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(working)
                    .accessibilityIdentifier("nameField")
                if working {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Button("Get this name") { start() }
                        .accessibilityIdentifier("nameButton")
                }
            } footer: {
                Text("This name goes on a public chain and stays there.")
                    .font(Theme.text(13))
            }
            .listRowBackground(Theme.surface)
            if let line {
                Text(line)
                    .foregroundStyle(Theme.muted)
                    .listRowBackground(Theme.surface)
                    .accessibilityIdentifier("nameLine")
            }
            if !userName.isEmpty {
                Section {
                    Text(userName)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("savedName")
                    if userNameState == "pending" {
                        Text("name being created")
                            .foregroundStyle(Theme.muted)
                    }
                    if let onClose {
                        Button("Continue") { onClose() }
                    }
                }
                .listRowBackground(Theme.surface)
            }
        }
        .font(Theme.text(15))
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("Your name")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onClose {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { onClose() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .task(id: userName) { await watchName() }
        .onDisappear { world.stop() }
    }

    private func start() {
        let wanted = label.trimmingCharacters(in: .whitespaces)
        guard Names.isLabel(wanted) else {
            line = Names.sentence(forRefusal: "label")
            return
        }
        line = nil
        working = true
        let base = AuthoriseLink.base(fromSettings: webAddress)
        Task {
            switch await world.join(base: base, label: wanted) {
            case .registered(let name, let state, let session):
                // If this person already has a name, this is that name.
                if let session {
                    userSession = session
                } else if name != userName {
                    userSession = ""
                }
                userNameState = state
                userName = name
                label = ""
            case .refused(let word):
                line = Names.sentence(forRefusal: word)
            case .worldFailed(let word):
                line = "World did not finish: \(word)"
            case .unavailable:
                line = "Names are not available now."
            case .useSheet:
                await joinInSheet(base: base, label: wanted)
            }
            working = false
        }
    }

    /// The page's way back is only a hint. The name counts only when the web side lists it.
    private func joinInSheet(base: String, label wanted: String) async {
        guard AuthoriseLink.sheetCanOpen(base: base), let link = AuthoriseLink.joinURL(base: base, label: wanted) else {
            line = "Names are not available now."
            return
        }
        let back = await sheet.open(link)
        guard let joined = Names.joinedLabel(back), let found = await Names.listing(base: base, label: joined) else {
            line = Names.sentence(forRefusal: "")
            return
        }
        if found.name != userName { userSession = "" }
        userNameState = found.state
        userName = found.name
        label = ""
    }

    /// Asks until the name is finished. It takes a while on the chain, so this goes on only while the screen is open.
    private func watchName() async {
        guard userNameState == "pending", let label = Names.label(of: userName) else { return }
        let base = AuthoriseLink.base(fromSettings: webAddress)
        for _ in 0..<60 {
            if let found = await Names.listing(base: base, label: label), found.state != "pending" {
                userNameState = found.state
                return
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if Task.isCancelled { return }
        }
    }
}
