import IDKit
import UIKit

/// The person's proof, made in the World app, with no web page between.
/// The web side starts it and finishes it. What it answers goes to the package as it is, and the package's result goes back as it is.
@MainActor
final class WorldStep {
    enum Outcome {
        case authorised
        case notAuthorised
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
    }

    /// The web side's signed start lasts five minutes, so no wait is longer.
    private static let mostWait: UInt64 = 300_000

    private var polling: Task<IDKitCompletionResult, Never>?

    func run(base: String, hash: String, event: String?) async -> Outcome {
        guard let start: Start = await post(base, "/api/world/request", body(hash: hash, event: event), limit: 15) else { return .useSheet }
        // This answer carries the seal's record itself.
        if start.state == "authorised" { return .authorised }
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
        guard case .success(let result) = await asking.value, let json = try? idkitResultToJson(result: result) else { return .notAuthorised }
        let finish: Finish? = await post(base, "/api/world/verify", body(hash: hash, event: event, result: json), limit: 60)
        // This answer is trusted as it is. A second call could miss a fresh record.
        if let finish { return finish.state == "verified" ? .authorised : .notAuthorised }
        // With no answer at all, the record may still have been kept.
        return await AuthoriseLink.hasRecord(base: base, hash: hash) ? .authorised : .notAuthorised
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
        let config = IDKitRequestConfig(appId: appID, action: action, rpContext: rp, allowLegacyProofs: false,
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
