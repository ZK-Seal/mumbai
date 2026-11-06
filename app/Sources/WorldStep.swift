import IDKit
import UIKit

/// The person's proof, made in the World app, with no web page between.
/// The web side starts it and finishes it. What it answers goes to the package as it is, and the package's result goes back as it is.
@MainActor
final class WorldStep {
    enum Outcome {
        /// The token comes only with the answer that made the record, and it lets the app send the picture once it has one.
        case authorised(pictureToken: String?)
        case notAuthorised
        /// World's own error word, from its fixed list.
        case worldFailed(String)
        /// The web side could not be read, or the World app could not be opened, so the sheet takes over.
        case useSheet
    }

    /// What the web side answers to a start. `ready` carries the rest.
    private struct Start: Decodable {
        struct Context: Decodable {
            var rp_id: String
            var nonce: String
            var created_at: UInt64
            var expires_at: UInt64
            var signature: String
        }
        var state: String
        var app_id: String?
        var action: String?
        var environment: String?
        var credential: String?
        var signal: String?
        var rp_context: Context?
    }

    private struct Finish: Decodable {
        var state: String
        var picture_token: String?

        /// Nil unless it has its fixed form, so nothing else can reach a header.
        var token: String? {
            guard let picture_token, picture_token.count == 64, picture_token.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
            return picture_token
        }
    }

    /// The web side's signed start lasts five minutes, so no wait is longer.
    private static let mostWait: UInt64 = 300_000

    private var polling: Task<IDKitCompletionResult, Never>?

    func run(base: String, hash: String, event: String?) async -> Outcome {
        guard let start: Start = await post(base, "/api/world/request", body(hash: hash, event: event), limit: 15) else { return .useSheet }
        // This answer carries the seal's record itself.
        if start.state == "authorised" { return .authorised(pictureToken: nil) }
        guard start.state == "ready", start.signal == hash else { return .notAuthorised }
        guard let request = await makeRequest(from: start, hash: hash) else { return .useSheet }
        // The asking starts first, and it goes on while the person is away and after they return, before or after the proof arrives.
        let asking = Task { await request.pollUntilCompletion(options: IDKitPollOptions(pollIntervalMs: 1_000, timeoutMs: Self.mostWait)) }
        polling = asking
        defer { polling = nil }
        guard await UIApplication.shared.open(request.connectorURL, options: [:]) else {
            asking.cancel()
            return .useSheet
        }
        let result: IDKitResult
        switch await asking.value {
        case .success(let proof): result = proof
        case .failure(let code): return .worldFailed(code.rawValue)
        }
        guard let json = try? idkitResultToJson(result: result) else { return .notAuthorised }
        let finish: Finish? = await post(base, "/api/world/verify", body(hash: hash, event: event, result: json), limit: 60)
        // This answer is trusted as it is. A second call could miss a fresh record.
        if let finish { return finish.state == "verified" ? .authorised(pictureToken: finish.token) : .notAuthorised }
        // With no answer at all, the record may still have been kept.
        return await AuthoriseLink.hasRecord(base: base, hash: hash) ? .authorised(pictureToken: nil) : .notAuthorised
    }

    func stop() {
        polling?.cancel()
    }

    private func makeRequest(from start: Start, hash: String) async -> IDKitRequest? {
        guard let appID = start.app_id, let action = start.action, let context = start.rp_context,
              let credential = start.credential, ["human", "selfie"].contains(credential),
              let rp = try? RpContext(rpId: context.rp_id, nonce: context.nonce, createdAt: context.created_at,
                                      expiresAt: context.expires_at, signature: context.signature) else { return nil }
        let place: Environment
        switch start.environment {
        case "production": place = .production
        case "staging": place = .staging
        case "sandbox": place = .sandbox
        default: return nil
        }
        // The return link only brings the person back. The result comes by asking, and the app trusts nothing in that link.
        // The same rule as the web page. The sandbox answers a human check only with an older proof.
        let config = IDKitRequestConfig(appId: appID, action: action, rpContext: rp, allowLegacyProofs: credential == "human",
                                        returnTo: "\(AuthoriseLink.returnScheme)://authorised", environment: place)
        let preset: Preset = credential == "human" ? .proofOfHuman(signal: hash) : .selfieCheck(signal: hash)
        // This call waits on the network, so it runs away from the screen's thread.
        return await Task.detached { try? IDKit.request(config: config).preset(preset) }.value
    }

    /// The hash and event have a fixed form, so they need no escaping. The result stays exactly as the package wrote it.
    private func body(hash: String, event: String?, result: String? = nil) -> String {
        var parts = ["\"hash\":\"\(hash)\""]
        if let event { parts.append("\"event\":\"\(event)\"") }
        if let result { parts.append("\"result\":\(result)") }
        return "{" + parts.joined(separator: ",") + "}"
    }

    /// A refusal has its own status, so the answer's words decide. The access word never goes with this.
    private func post<Answer: Decodable>(_ base: String, _ path: String, _ body: String, limit: TimeInterval) async -> Answer? {
        guard let url = AuthoriseLink.address(base: base, path: path) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: limit)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return nil }
        return try? JSONDecoder().decode(Answer.self, from: data)
    }
}
