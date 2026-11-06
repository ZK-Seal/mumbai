import Foundation

/// The web page where a person can authorise a seal. The app only opens it in the browser.
enum AuthoriseLink {
    /// The page's address, from the WEB_URL environment variable, else from Settings. It is never in the code.
    static func base(fromSettings text: String) -> String {
        (ProcessInfo.processInfo.environment["WEB_URL"] ?? text).trimmingCharacters(in: .whitespaces)
    }

    /// The full address with its values encoded. Nil if the base is empty or is not a web address.
    static func url(base: String, hash: String, edit: String, width: Int, height: Int) -> URL? {
        guard !base.isEmpty, var parts = URLComponents(string: base),
              ["http", "https"].contains(parts.scheme ?? ""), parts.host != nil else { return nil }
        parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + "/authorise"
        parts.queryItems = [
            URLQueryItem(name: "hash", value: hash),
            URLQueryItem(name: "edit", value: edit),
            URLQueryItem(name: "w", value: String(width)),
            URLQueryItem(name: "h", value: String(height)),
        ]
        return parts.url
    }
}
