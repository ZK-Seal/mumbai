import Foundation

/// An image's ENS name, as the web side gives it. While its state is pending, it may have no name yet.
struct ImageName: Decodable, Equatable {
    var name: String?
    var state: String
}

/// A name's state in the web side's answers. It may come as one word, or as an object with a state.
struct NameState: Decodable {
    var state = "pending"

    init(from decoder: Decoder) throws {
        enum Keys: String, CodingKey { case state }
        if let word = try? decoder.singleValueContainer().decode(String.self) {
            state = word
        } else if let word = try? decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .state) {
            state = word
        }
    }
}

/// The short names people choose, and the ENS names the web side makes. These answers are public, so no access word goes with them.
enum Names {
    /// 3 to 20 lowercase letters, digits and hyphens, with no hyphen first.
    static func isLabel(_ text: String) -> Bool {
        text.range(of: #"^[a-z0-9][a-z0-9-]{2,19}\z"#, options: .regularExpression) != nil
    }

    /// The form of a full ENS name, so that nothing else reaches the screen.
    static func isName(_ text: String) -> Bool {
        text.count <= 128 && text.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+\z"#, options: .regularExpression) != nil
    }

    /// The first part of a full name.
    static func label(of name: String) -> String? {
        name.split(separator: ".").first.map(String.init).flatMap { isLabel($0) ? $0 : nil }
    }

    /// The name the web side lists, and its state now. Nil if the web side has no answer or does not list it.
    static func listing(base: String, label: String) async -> (name: String, state: String)? {
        struct Answer: Decodable {
            var state: String
            var name: String?
            var ens: NameState?
        }
        guard let answer: Answer = await read(base: base, path: "/api/user/\(label)"), answer.state == "listed",
              let name = answer.name, isName(name) else { return nil }
        return (name, answer.ens?.state ?? "pending")
    }

    /// The label in the join page's way back: blankdemo://authorised?state=joined&label=<label>
    /// This alone is never believed. Any other state, such as cancelled, gives nil.
    static func joinedLabel(_ back: URL?) -> String? {
        guard let back, let parts = URLComponents(url: back, resolvingAgainstBaseURL: false),
              parts.scheme == AuthoriseLink.returnScheme, parts.host == "authorised", let items = parts.queryItems else { return nil }
        let states = items.filter { $0.name == "state" }
        let labels = items.filter { $0.name == "label" }
        guard states.count == 1, states[0].value == "joined", labels.count == 1, let label = labels[0].value, isLabel(label) else { return nil }
        return label
    }

    /// The ENS name of this seal's image, once the web side has one.
    static func image(base: String, hash: String) async -> ImageName? {
        struct Answer: Decodable { var image: ImageName? }
        let answer: Answer? = await read(base: base, path: "/api/seal/\(hash)")
        return valid(answer?.image)
    }

    static func valid(_ image: ImageName?) -> ImageName? {
        guard let image else { return nil }
        if let name = image.name { return isName(name) ? image : nil }
        return image.state == "pending" ? image : nil
    }

    /// One plain line for each refusal. Nothing the web side says is shown as written.
    static func sentence(forRefusal word: String) -> String {
        switch word {
        case "label": return "Use 3 to 20 lowercase letters, digits or hyphens, with no hyphen first."
        case "taken": return "This name is taken. Try another."
        case "not-set-up": return "Names are not set up yet."
        case "store": return "The list of names cannot be read now. Try again."
        case "not-this-name": return "The proof was for another name. Try again."
        case "not-verified": return "World did not accept the proof. Try again."
        default: return "The name could not be made. Try again."
        }
    }

    /// Only a 200 counts here, so a route that is not there gives nil.
    private static func read<Answer: Decodable>(base: String, path: String) async -> Answer? {
        guard let url = AuthoriseLink.address(base: base, path: path) else { return nil }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(Answer.self, from: data)
    }
}
