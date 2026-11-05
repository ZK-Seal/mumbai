import Foundation

/// A job's state as the service reports it. Every text field is one word from a fixed list.
struct ServiceJob: Decodable {
    var state: String
    var reason: String?
    var edit: String?
    var check: String?
    var areas: [[Int]]?
    var origin: String?
    var seal_signer: String?
    var sha256: String?
}

enum ServiceError: Error {
    /// The service answered no, with this reason word.
    case refused(String)
    /// The service could not be reached, or its answer could not be read.
    case unreachable
}

/// Talks to the sealing service over HTTP.
struct ServiceClient {
    let base: URL

    /// The address from the SERVICE_URL environment variable, else from Settings. It is never in the code.
    static func address(fromSettings text: String) -> URL? {
        let value = ProcessInfo.processInfo.environment["SERVICE_URL"] ?? text
        guard let url = URL(string: value.trimmingCharacters(in: .whitespaces)),
              ["http", "https"].contains(url.scheme ?? ""), url.host != nil else { return nil }
        return url
    }

    /// Sends the photo and the box. Returns the job's id.
    func seal(jpeg: Data, box: GridBox) async throws -> String {
        var request = URLRequest(url: base.appendingPathComponent("seal"))
        request.httpMethod = "POST"
        request.setValue("\(box.x),\(box.y),\(box.width),\(box.height)", forHTTPHeaderField: "X-Areas")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.httpBody = jpeg
        struct Started: Decodable { var id: String }
        let (data, code) = try await send(request)
        if code == 202, let started = try? JSONDecoder().decode(Started.self, from: data) {
            return started.id
        }
        throw refusal(data)
    }

    /// The job's state now.
    func job(id: String) async throws -> ServiceJob {
        let (data, code) = try await send(URLRequest(url: base.appendingPathComponent("seal/\(id)")))
        if code == 200, let job = try? JSONDecoder().decode(ServiceJob.self, from: data) {
            return job
        }
        throw refusal(data)
    }

    func send(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw ServiceError.unreachable
        }
    }

    private func refusal(_ data: Data) -> ServiceError {
        if let job = try? JSONDecoder().decode(ServiceJob.self, from: data), let reason = job.reason {
            return .refused(reason)
        }
        return .unreachable
    }
}

/// The fixed sentence for each reason word. Nothing the service says is shown as written.
func sentence(forReason reason: String) -> String {
    switch reason {
    case "off-grid": return "The box is not on the grid. Check the cell size."
    case "outside": return "The box reaches outside the photo."
    case "too-big": return "The photo is too large to send."
    case "too-many-pixels": return "The photo has too many pixels."
    case "format": return "This photo's format cannot be used here."
    case "rotation": return "This photo has a rotation tag. It cannot be used here yet."
    case "small-copy": return "This photo carries a small copy of itself, so it was refused."
    case "busy": return "Another job is running. Try again soon."
    case "memory": return "The server has too little free memory now. Try again soon."
    case "too-long": return "The job took too long and was stopped."
    case "photo", "not-jpeg", "areas", "empty": return "This photo was refused."
    default: return "The job failed. Try again."
    }
}
