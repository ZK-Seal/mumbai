import Foundation

/// The web page where a person can authorise a seal, and the web side's record of it.
enum AuthoriseLink {
    /// The scheme of the page's way back to the app.
    static let returnScheme = "blankdemo"

    /// The page's address, from the WEB_URL environment variable, else from Settings. It is never in the code.
    static func base(fromSettings text: String) -> String {
        (ProcessInfo.processInfo.environment["WEB_URL"] ?? text).trimmingCharacters(in: .whitespaces)
    }

    /// The event's short name, from the EVENT_SLUG environment variable, else from Settings.
    /// Nil unless it has the form the page accepts, because the page refuses a whole link with any other.
    static func event(fromSettings text: String) -> String? {
        let value = (ProcessInfo.processInfo.environment["EVENT_SLUG"] ?? text).trimmingCharacters(in: .whitespaces)
        return value.range(of: #"^[a-z0-9][a-z0-9-]{2,39}\z"#, options: .regularExpression) != nil ? value : nil
    }

    /// A path on the web address. Nil if the base is empty or is not a web address.
    private static func place(base: String, path: String) -> URLComponents? {
        guard !base.isEmpty, var parts = URLComponents(string: base),
              ["http", "https"].contains(parts.scheme ?? ""), parts.host != nil else { return nil }
        parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + path
        return parts
    }

    /// A web page in a sheet needs a secure address, so with a plain http web address the app does not offer the sheet.
    static func sheetCanOpen(base: String) -> Bool {
        URLComponents(string: base)?.scheme == "https"
    }

    /// A plain address on the web side, with no values. Nil if the base is empty or is not a web address.
    static func address(base: String, path: String) -> URL? {
        guard var parts = place(base: base, path: path) else { return nil }
        parts.query = nil
        return parts.url
    }

    /// The full address with its values encoded. Nil if the base is empty or is not a web address.
    static func url(base: String, hash: String, edit: String, width: Int, height: Int, event: String? = nil) -> URL? {
        guard var parts = place(base: base, path: "/authorise") else { return nil }
        parts.queryItems = [
            URLQueryItem(name: "hash", value: hash),
            URLQueryItem(name: "edit", value: edit),
            URLQueryItem(name: "w", value: String(width)),
            URLQueryItem(name: "h", value: String(height)),
            URLQueryItem(name: "from", value: "app"),
        ]
        if let event { parts.queryItems?.append(URLQueryItem(name: "event", value: event)) }
        return parts.url
    }

    /// The web side's join page, in a sheet, for when the World app cannot be opened from here.
    static func joinURL(base: String, label: String) -> URL? {
        guard var parts = place(base: base, path: "/join") else { return nil }
        parts.queryItems = [URLQueryItem(name: "from", value: "app"), URLQueryItem(name: "label", value: label)]
        return parts.url
    }

    /// Whether the page's way back says this very seal was authorised: blankdemo://authorised?hash=<hash>&state=authorised
    /// This alone is never believed.
    static func saysAuthorised(_ back: URL?, hash: String) -> Bool {
        guard let back, let parts = URLComponents(url: back, resolvingAgainstBaseURL: false),
              parts.scheme == returnScheme, parts.host == "authorised", let items = parts.queryItems else { return false }
        let hashes = items.filter { $0.name == "hash" }
        let states = items.filter { $0.name == "state" }
        return hashes.count == 1 && hashes[0].value == hash && states.count == 1 && states[0].value == "authorised"
    }

    /// Whether the web side answers with a record for this seal. The access word never goes with this.
    static func hasRecord(base: String, hash: String) async -> Bool {
        guard let url = address(base: base, path: "/api/seal/\(hash)") else { return false }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        struct Answer: Decodable { var state: String }
        return (try? JSONDecoder().decode(Answer.self, from: data))?.state == "authorised"
    }
}
