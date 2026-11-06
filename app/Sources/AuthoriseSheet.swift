import AuthenticationServices
import UIKit

/// Opens the authorise page in a sheet over the app, and waits for the page to come back.
/// The sheet is not ephemeral, so a hop to another app and back finds the same page.
@MainActor
final class AuthoriseSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var waiting: CheckedContinuation<URL?, Never>?

    /// The link the page came back with. Nil after a cancel or an error.
    func open(_ link: URL) async -> URL? {
        await withCheckedContinuation { waiting in
            self.waiting = waiting
            let session = ASWebAuthenticationSession(url: link, callbackURLScheme: AuthoriseLink.returnScheme) { back, _ in
                DispatchQueue.main.async { self.finish(back) }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { finish(nil) }
        }
    }

    /// A failed start can also call the session's handler, so this answers only once.
    private func finish(_ back: URL?) {
        waiting?.resume(returning: back)
        waiting = nil
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
    }
}
