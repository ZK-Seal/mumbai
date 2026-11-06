import UIKit

enum AreaPreview {
    /// The main yellow of the face's picture. The area's cells are filled with it.
    private static let yellow = UIColor(red: 185 / 255, green: 137 / 255, blue: 6 / 255, alpha: 1)

    /// The picture with the area in flat yellow and the face as large as fits inside it.
    /// It depends only on the boxes. It reads no pixel of the picture to draw them.
    static func face(_ image: UIImage, boxes: [GridBox], cell: Int) -> UIImage? {
        let (width, height) = (Int(image.size.width * image.scale), Int(image.size.height * image.scale))
        guard cell > 0, width > 0, height > 0, let face = UIImage(named: "AreaFace"), let outline = FaceOutline(face),
              let spot = CellArea(boxes: boxes, width: width, height: height, cell: cell)?.largestSpot(for: outline) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let size = CGSize(width: width, height: height)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            image.draw(in: CGRect(origin: .zero, size: size))
            yellow.setFill()
            for box in boxes {
                context.fill(CGRect(x: box.x, y: box.y, width: box.width, height: box.height))
            }
            context.cgContext.interpolationQuality = .high
            face.draw(in: CGRect(x: spot.centre.x - spot.half, y: spot.centre.y - spot.half, width: 2 * spot.half, height: 2 * spot.half))
        }
    }
}

/// The edge of the face in its square picture: points around its middle, where half the square's side is 1.
private struct FaceOutline {
    let points: [CGPoint]

    init?(_ face: UIImage) {
        guard let picture = face.cgImage, picture.width == picture.height, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let side = picture.width
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        let drew: Bool = bytes.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(picture, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drew else { return nil }
        let half = Double(side) / 2
        points = (0..<72).map { step in
            let angle = Double(step) / 72 * 2 * .pi
            var reach = half
            // From the square's edge inward, to the first pixel that is mostly there.
            while reach > 0 {
                let x = Int(half + reach * cos(angle))
                let y = Int(half + reach * sin(angle))
                if x >= 0, y >= 0, x < side, y < side, bytes[(y * side + x) * 4 + 3] >= 128 { break }
                reach -= 1
            }
            return CGPoint(x: reach / half * cos(angle), y: reach / half * sin(angle))
        }
    }
}

/// Which cells are in the boxes.
private struct CellArea {
    let cell: CGFloat
    let columns: Int
    let rows: Int
    private var marked: [Bool]
    private var middle = CGPoint.zero

    init?(boxes: [GridBox], width: Int, height: Int, cell: Int) {
        self.cell = CGFloat(cell)
        columns = (width + cell - 1) / cell
        rows = (height + cell - 1) / cell
        marked = [Bool](repeating: false, count: columns * rows)
        var (count, sumColumn, sumRow) = (0, 0, 0)
        for box in boxes {
            for row in box.y / cell..<min((box.y + box.height + cell - 1) / cell, rows) {
                for column in box.x / cell..<min((box.x + box.width + cell - 1) / cell, columns) where !marked[row * columns + column] {
                    marked[row * columns + column] = true
                    count += 1
                    sumColumn += column
                    sumRow += row
                }
            }
        }
        guard count > 0 else { return nil }
        middle = CGPoint(x: (CGFloat(sumColumn) / CGFloat(count) + 0.5) * self.cell, y: (CGFloat(sumRow) / CGFloat(count) + 0.5) * self.cell)
    }

    private func holds(_ x: CGFloat, _ y: CGFloat) -> Bool {
        guard x >= 0, y >= 0 else { return false }
        let (column, row) = (Int(x / cell), Int(y / cell))
        return column < columns && row < rows && marked[row * columns + column]
    }

    /// Whether the face, with half its picture's side this long, stays in the cells. It also checks inside the edge.
    private func fits(_ outline: FaceOutline, _ centre: CGPoint, _ half: CGFloat) -> Bool {
        for share in [1, 0.8, 0.5] as [CGFloat] {
            for point in outline.points where !holds(centre.x + point.x * half * share, centre.y + point.y * half * share) {
                return false
            }
        }
        return true
    }

    /// The place where the face can be largest, nearest the area's middle among equals. It almost touches the edges.
    func largestSpot(for outline: FaceOutline) -> (centre: CGPoint, half: CGFloat)? {
        var best: (centre: CGPoint, half: CGFloat, offMiddle: CGFloat)?
        let limit = max(CGFloat(columns), CGFloat(rows)) * cell
        for row in 0..<rows {
            for column in 0..<columns where marked[row * columns + column] {
                let centre = CGPoint(x: (CGFloat(column) + 0.5) * cell, y: (CGFloat(row) + 0.5) * cell)
                let offMiddle = hypot(centre.x - middle.x, centre.y - middle.y)
                let known = best?.half ?? cell / 2
                guard fits(outline, centre, known) else { continue }
                if fits(outline, centre, known + 1) {
                    var (low, high) = (known + 1, limit)
                    while high - low > 1 {
                        let half = (low + high) / 2
                        if fits(outline, centre, half) { low = half } else { high = half }
                    }
                    best = (centre, low, offMiddle)
                } else if offMiddle < best?.offMiddle ?? .greatestFiniteMagnitude {
                    best = (centre, known, offMiddle)
                }
            }
        }
        // A thin shape may not hold even the smallest face. Then it takes one cell's size at the area's middle.
        guard let best else { return (middle, cell / 2) }
        return (best.centre, best.half * 0.98)
    }
}
