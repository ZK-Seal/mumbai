import IDKit
import UIKit

/// The person's proof, made in the World app, with no web page between.
/// The web side starts it and finishes it. What it answers goes to the package as it is, and the package's result goes back as it is.
@MainActor
final class WorldStep {
    enum Outcome {
        /// The token comes only with the answer that made the record, and it lets the app send the picture once it has one.
        case authorised(pictureToken: String?, image: ImageName?)
        case notAuthorised
        /// World's own error word, from its fixed list.
        case worldFailed(String)
        /// The web side's own words for why not, shown as they are.
        case refused(text: String)
        /// The web side does not accept the saved session.
        case sessionRefused(text: String?)
        /// The web side does not accept this person's badge for this event.
        case noEntry
        /// The web side could not be read, or the World app could not be opened, so the sheet takes over.
        case useSheet
    }

    enum JoinOutcome {
        case registered(name: String, label: String, state: String, session: String?)
        /// The web side's own word for why not, and its own words to show, if it gave them.
        case refused(String, text: String?)
        /// World's own error word, from its fixed list.
        case worldFailed(String)
        /// The routes are not there, or the answer could not be read.
        case unavailable
        /// The web side is ready, but the World app could not be opened from here, so its join page takes over.
        case useSheet
    }

    private enum Proof {
        case json(String)
        case worldFailed(String)
        case cannotStart
        case unreadable
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
        var reason: String?
        var text: String?
        var label: String?
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
        var image: ImageName?
        var reason: String?
        var text: String?

        /// Only the state is needed. An extra field in another form must not undo "verified".
        init(from decoder: Decoder) throws {
            enum Keys: String, CodingKey { case state, picture_token, image, reason, text }
            let box = try decoder.container(keyedBy: Keys.self)
            state = try box.decode(String.self, forKey: .state)
            picture_token = try? box.decodeIfPresent(String.self, forKey: .picture_token)
            image = try? box.decodeIfPresent(ImageName.self, forKey: .image)
            reason = try? box.decodeIfPresent(String.self, forKey: .reason)
            text = try? box.decodeIfPresent(String.self, forKey: .text)
        }

        /// Nil unless it has its fixed form, so nothing else can reach a header.
        var token: String? {
            guard let picture_token, picture_token.count == 64, picture_token.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
            return picture_token
        }
    }

    /// The web side's signed start lasts five minutes, so no wait is longer.
    private static let mostWait: UInt64 = 300_000

    private struct Joined: Decodable {
        var state: String
        var reason: String?
        var text: String?
        var label: String?
        var name: String?
        var ens: NameState?
        var session: String?
    }

    private var polling: Task<IDKitCompletionResult, Never>?

    /// With the person's session there is no second World trip: their name was proved at join, and the web side files this photo under it.
    /// Without a session, the photo has its own World step and stays unnamed.
    /// The ticket says the service checked this hash. It goes both in the body and as a header.
    /// `entry` is the SHA-256 of the person's scanned badge for this event.
    func run(base: String, hash: String, event: String?, session: String?, ticket: String?, entry: String?) async -> Outcome {
        if let session {
            let finish: Finish? = await post(base, "/api/world/verify", body(hash: hash, event: event, session: session, ticket: ticket, entry: entry), limit: 120, ticket: ticket)
            return await ending(finish, base: base, hash: hash)
        }
        guard let start: Start = await post(base, "/api/world/request", body(hash: hash, event: event, ticket: ticket, entry: entry), limit: 15, ticket: ticket) else { return .useSheet }
        // This answer carries the seal's record itself.
        if start.state == "authorised" { return .authorised(pictureToken: nil, image: nil) }
        if start.reason == "no-entry" { return .noEntry }
        guard start.state == "ready", start.signal == hash else { return Self.words(start.text).map { .refused(text: $0) } ?? .notAuthorised }
        let json: String
        switch await prove(start, signal: hash) {
        case .json(let made): json = made
        case .worldFailed(let word): return .worldFailed(word)
        case .cannotStart: return .useSheet
        case .unreadable: return .notAuthorised
        }
        let finish: Finish? = await post(base, "/api/world/verify", body(hash: hash, event: event, result: json, ticket: ticket, entry: entry), limit: 120, ticket: ticket)
        return await ending(finish, base: base, hash: hash)
    }

    /// What the web side's last answer means, for a photo with or without a session.
    private func ending(_ finish: Finish?, base: String, hash: String) async -> Outcome {
        if finish?.reason == "no-entry" { return .noEntry }
        if finish?.reason == "session" { return .sessionRefused(text: Self.words(finish?.text)) }
        // This answer is trusted as it is. A second call could miss a fresh record.
        if let finish {
            if finish.state == "verified" { return .authorised(pictureToken: finish.token, image: Names.valid(finish.image)) }
            return Self.words(finish.text).map { .refused(text: $0) } ?? .notAuthorised
        }
        // With no answer at all, the record may still have been kept.
        return await AuthoriseLink.hasRecord(base: base, hash: hash) ? .authorised(pictureToken: nil, image: nil) : .notAuthorised
    }

    /// The web side's words to show, if it gave any.
    private static func words(_ text: String?) -> String? {
        text.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// One person's name: the same World step, with the signal the web side gives. What was typed goes as it is, and the web side alone decides if it can be a name.
    /// From its first answer on, only the web side's own form of the name is used.
    func join(base: String, typed: String) async -> JoinOutcome {
        guard let sent = Self.jsonText(typed),
              let start: Start = await post(base, "/api/user/request", "{\"label\":\(sent)}", limit: 15) else { return .unavailable }
        switch start.state {
        case "ready": break
        case "taken": return .refused("taken", text: Self.words(start.text))
        case "refused": return .refused(start.reason ?? "", text: Self.words(start.text))
        default: return .unavailable
        }
        let label = start.label ?? typed
        guard let signal = start.signal, !signal.isEmpty, Names.isLabel(label), let settled = Self.jsonText(label) else { return .unavailable }
        let json: String
        switch await prove(start, signal: signal) {
        case .json(let made): json = made
        case .worldFailed(let word): return .worldFailed(word)
        case .cannotStart: return .useSheet
        case .unreadable: return .unavailable
        }
        let answer: Joined? = await post(base, "/api/user/register", "{\"label\":\(settled),\"result\":\(json)}", limit: 60)
        guard let answer else { return .unavailable }
        if answer.state == "registered", let name = answer.name, Names.isName(name) {
            // If this person already has a name, the answer's own name is the one to keep.
            let saved = answer.label.flatMap { Names.isLabel($0) ? $0 : nil } ?? Names.label(of: name) ?? label
            return .registered(name: name, label: saved, state: answer.ens?.state ?? "pending", session: answer.session.flatMap { Names.isSession($0) ? $0 : nil })
        }
        return .refused(answer.state == "taken" ? "taken" : answer.reason ?? "", text: Self.words(answer.text))
    }

    /// Text a person typed, as a JSON string.
    private static func jsonText(_ text: String) -> String? {
        (try? JSONEncoder().encode(text)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// One proof from the World app, as the web side's answer asks for it. The result comes back as the package wrote it.
    private func prove(_ start: Start, signal: String) async -> Proof {
        guard let request = await makeRequest(from: start, signal: signal) else { return .cannotStart }
        // The asking starts first, and it goes on while the person is away and after they return, before or after the proof arrives.
        let asking = Task { await request.pollUntilCompletion(options: IDKitPollOptions(pollIntervalMs: 1_000, timeoutMs: Self.mostWait)) }
        polling = asking
        defer { polling = nil }
        guard await UIApplication.shared.open(request.connectorURL, options: [:]) else {
            asking.cancel()
            return .cannotStart
        }
        switch await asking.value {
        case .failure(let code):
            return .worldFailed(code.rawValue)
        case .success(let result):
            guard let json = try? idkitResultToJson(result: result) else { return .unreadable }
            return .json(json)
        }
    }

    func stop() {
        polling?.cancel()
    }

    private func makeRequest(from start: Start, signal: String) async -> IDKitRequest? {
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
        let preset: Preset = credential == "human" ? .proofOfHuman(signal: signal) : .selfieCheck(signal: signal)
        // This call waits on the network, so it runs away from the screen's thread.
        return await Task.detached { try? IDKit.request(config: config).preset(preset) }.value
    }

    /// The hash and event have a fixed form, so they need no escaping. The result stays exactly as the package wrote it.
    private func body(hash: String, event: String?, result: String? = nil, session: String? = nil, ticket: String? = nil, entry: String? = nil) -> String {
        var parts = ["\"hash\":\"\(hash)\""]
        if let event { parts.append("\"event\":\"\(event)\"") }
        if let result { parts.append("\"result\":\(result)") }
        if let session { parts.append("\"session\":\"\(session)\"") }
        if let ticket { parts.append("\"ticket\":\"\(ticket)\"") }
        if let entry { parts.append("\"entry\":\"\(entry)\"") }
        return "{" + parts.joined(separator: ",") + "}"
    }

    /// A refusal has its own status, so the answer's words decide. The access word never goes with this.
    private func post<Answer: Decodable>(_ base: String, _ path: String, _ body: String, limit: TimeInterval, ticket: String? = nil) async -> Answer? {
        guard let url = AuthoriseLink.address(base: base, path: path) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: limit)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(ticket, forHTTPHeaderField: "x-seal-ticket")
        request.httpBody = Data(body.utf8)
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return nil }
        return try? JSONDecoder().decode(Answer.self, from: data)
    }
}
