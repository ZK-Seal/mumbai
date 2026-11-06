import SwiftUI

/// Which event a photo goes to: one of the listed ones, another by its short name, or none.
/// A photo going to an event needs that event's badge. That scan stays at Publish, once per event.
struct EventChooser: View {
    /// In a settings list the row has no box of its own.
    var plain = false

    @AppStorage("event") private var event = ""
    @State private var asking = false
    @State private var typed = ""
    @State private var refused = false

    private static let listed = ["ethglobal", "devcon", "devconnect"]
    private static let rule = "Use 3 to 40 lowercase letters, digits and hyphens, with no hyphen first."

    private var chosen: String? { AuthoriseLink.event(fromSettings: event) }

    var body: some View {
        VStack(spacing: 6) {
            // Set at launch, the event cannot be changed here, so no choice is offered.
            if AuthoriseLink.eventIsFixed {
                row(arrows: false)
            } else {
                Menu {
                    choice("None", value: "")
                    ForEach(Self.listed, id: \.self) { slug in
                        choice(slug, value: slug)
                    }
                    Button("Other") {
                        typed = ""
                        asking = true
                    }
                } label: {
                    row(arrows: true)
                }
                .accessibilityIdentifier("eventChooser")
            }
            if refused {
                Text(Self.rule)
                    .font(Theme.text(13))
                    .foregroundStyle(Theme.refused)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
        }
        .alert("Event's short name", isPresented: $asking) {
            TextField("Short name", text: $typed)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Use") { useTyped() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(Self.rule)
        }
    }

    private func row(arrows: Bool) -> some View {
        let words = HStack {
            Text("Event")
                .foregroundStyle(Theme.muted)
            Spacer()
            Text(chosen ?? "None")
                .lineLimit(1)
                .truncationMode(.middle)
            if arrows {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
            }
        }
        .font(Theme.text(15))
        return Group {
            if plain {
                words
            } else {
                words
                    .padding(12)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
            }
        }
    }

    private func choice(_ title: String, value: String) -> some View {
        Button {
            event = value
            refused = false
        } label: {
            if (chosen ?? "") == value {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func useTyped() {
        let value = typed.trimmingCharacters(in: .whitespaces)
        guard AuthoriseLink.isEvent(value) else {
            refused = true
            return
        }
        event = value
        refused = false
    }
}
