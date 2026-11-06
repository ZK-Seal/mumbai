import UIKit

/// Sends the result picture to the web side, which puts it where anyone can read it.
/// `covered` must be the result screen's picture: the backend's plain copy with the cover flattened onto it.
/// The photo on the phone and the sealed file never come here.
enum PictureUpload {
    private static let goodSize = 1_000_000
    private static let leastSize = 1_024
    private static let mostSize = 3 * 1_024 * 1_024

    /// The picture as a JPEG with no metadata: the largest try of about 1 MB or less, else the smallest try if it is within the limits.
    static func jpeg(from covered: UIImage) -> Data? {
        var last: Data?
        for longSide in [nil, 1_600, 1_200] as [CGFloat?] {
            guard let picture = flattened(covered, longSide: longSide) else { return nil }
            for quality in [0.8, 0.6] as [CGFloat] {
                guard let jpeg = picture.jpegData(compressionQuality: quality).flatMap(withoutMetadata) else { return nil }
                if jpeg.count <= goodSize { return jpeg.count >= leastSize ? jpeg : nil }
                last = jpeg
            }
        }
        return last.flatMap { $0.count <= mostSize ? $0 : nil }
    }

    /// One solid layer of pixels, at this long side or at its own size if that is smaller.
    private static func flattened(_ image: UIImage, longSide: CGFloat?) -> UIImage? {
        let (width, height) = (image.size.width * image.scale, image.size.height * image.scale)
        guard width > 0, height > 0 else { return nil }
        let share = min(1, (longSide ?? .greatestFiniteMagnitude) / max(width, height))
        let size = CGSize(width: (width * share).rounded(), height: (height * share).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// The same JPEG with every APP and comment segment taken out. Nil unless it starts and ends as a JPEG should.
    static func withoutMetadata(_ jpeg: Data) -> Data? {
        let bytes = [UInt8](jpeg)
        guard bytes.count > 4, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[bytes.count - 2] == 0xFF, bytes[bytes.count - 1] == 0xD9 else { return nil }
        var kept: [UInt8] = [0xFF, 0xD8]
        var at = 2
        while at + 4 <= bytes.count, bytes[at] == 0xFF {
            let marker = bytes[at + 1]
            // From the start of the scan on, it is all picture.
            if marker == 0xDA { return Data(kept + bytes[at...]) }
            let length = Int(bytes[at + 2]) << 8 | Int(bytes[at + 3])
            guard length >= 2, at + 2 + length <= bytes.count else { return nil }
            if !(0xE0...0xEF).contains(marker), marker != 0xFE { kept += bytes[at..<at + 2 + length] }
            at += 2 + length
        }
        return nil
    }

    /// True only if the web side says it kept the picture. The access word never goes with this.
    static func send(_ jpeg: Data, base: String, hash: String, token: String) async -> Bool {
        guard let url = AuthoriseLink.address(base: base, path: "/api/picture/\(hash)") else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-picture-token")
        request.httpBody = jpeg
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        struct Answer: Decodable { var state: String }
        return (try? JSONDecoder().decode(Answer.self, from: data))?.state == "stored"
    }
}
