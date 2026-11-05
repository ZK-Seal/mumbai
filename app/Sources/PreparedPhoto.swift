import UIKit

/// A photo ready to send: drawn upright, no longer than the long side, cut to whole cells,
/// and made into a JPEG. The screen shows this same JPEG, so the box is in its pixels.
struct PreparedPhoto {
    let image: UIImage
    let jpeg: Data
    let width: Int
    let height: Int

    /// `longSide` nil keeps the full size. Nil if the photo is smaller than one cell.
    static func make(from source: UIImage, longSide: Int?, cell: Int) -> PreparedPhoto? {
        let long = max(source.size.width, source.size.height) * source.scale
        guard long > 0, cell > 0 else { return nil }
        let shrink = longSide.map { min(1, CGFloat($0) / long) } ?? 1
        let drawn = CGSize(width: source.size.width * source.scale * shrink, height: source.size.height * source.scale * shrink)
        let width = Int(drawn.width) / cell * cell
        let height = Int(drawn.height) / cell * cell
        guard width > 0, height > 0 else { return nil }

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        let jpeg = renderer.jpegData(withCompressionQuality: 0.9) { _ in
            source.draw(in: CGRect(origin: .zero, size: drawn))
        }
        guard let image = UIImage(data: jpeg) else { return nil }
        return PreparedPhoto(image: image, jpeg: jpeg, width: width, height: height)
    }
}
