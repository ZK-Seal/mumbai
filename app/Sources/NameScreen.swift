import SwiftUI

/// The person's short name. World proves one human, and the web side makes the name and finishes it in the background.
struct NameScreen: View {
    /// Set when this step comes from Publish. The step closes once the name is there, and Publish goes on.
    var onClose: (() -> Void)?

    @AppStorage("webAddress") private var webAddress = ""
    @AppStorage("userName") private var userName = ""
    @AppStorage("userLabel") private var userLabel = ""
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
                TextField("Nickname", text: $label)
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
                }
                .listRowBackground(Theme.surface)
            }
        }
        .font(Theme.text(15))
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("Your nickname")
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
        let typed = label
        line = nil
        working = true
        let base = AuthoriseLink.base(fromSettings: webAddress)
        Task {
            switch await world.join(base: base, typed: typed) {
            case .registered(let name, let saved, let state, let session):
                // If this person already has a name, this is that name.
                if let session {
                    userSession = session
                } else if name != userName {
                    userSession = ""
                }
                userNameState = state
                userLabel = saved
                userName = name
                label = ""
                onClose?()
            case .refused(let word):
                line = Names.sentence(forRefusal: word)
            case .worldFailed(let word):
                line = "World did not finish: \(word)"
            case .unavailable:
                line = "Names are not available now."
            case .useSheet:
                await joinInSheet(base: base, label: typed)
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
        if let session = Names.joinedSession(back) {
            userSession = session
        } else if found.name != userName {
            userSession = ""
        }
        userNameState = found.state
        userLabel = joined
        userName = found.name
        label = ""
        onClose?()
    }

    /// Asks until the name is finished. It takes a while on the chain, so this goes on only while the screen is open.
    private func watchName() async {
        guard userNameState == "pending", let label = Names.savedLabel(userLabel, name: userName) else { return }
        if let state = await Names.waitForName(base: AuthoriseLink.base(fromSettings: webAddress), label: label) {
            userNameState = state
        }
    }
}
