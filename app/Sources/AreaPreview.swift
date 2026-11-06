import SwiftUI
import UIKit

enum AreaPreview {
    /// The main yellow of the face's picture. The area is filled with it.
    fileprivate static let yellow = UIColor(red: 185 / 255, green: 137 / 255, blue: 6 / 255, alpha: 1)
    /// How many cells the yellow reaches past the sealed cells. This rounds its edge and covers every corner.
    fileprivate static let reach = 2
    /// The width of the drawing screen's layers: enough for the screen, and much lighter than the photo.
    private static let layerWidth = 1100

    /// The drawing screen's two clear layers. The new shape's layer can arrive softly over the others.
    struct Layers {
        let still: UIImage
        let fresh: UIImage?
        let anchor: UnitPoint
    }

    /// The result: the picture with the area in flat yellow and, in each separate piece of it, a face as large as fits.
    /// It depends only on the boxes. It reads no pixel of the picture to draw them.
    static func face(_ image: UIImage, boxes: [GridBox], cell: Int) -> UIImage? {
        let (width, height) = (Int(image.size.width * image.scale), Int(image.size.height * image.scale))
        guard let plan = FacePlan(boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        let size = CGSize(width: width, height: height)
        return renderer(size, opaque: true).image { context in
            image.draw(in: CGRect(origin: .zero, size: size))
            paintYellow(boxes, cell: cell)
            plan.drawFaces(in: context.cgContext, where: { _ in true })
        }
    }

    /// The same drawing, with no photo in it, for the drawing screen. `older` is the area before the newest shape.
    /// The piece that holds `newest` goes on the fresh layer, and all the rest on the still one.
    static func layers(width: Int, height: Int, boxes: [GridBox], older: [GridBox], newest: GridBox?, cell: Int) -> Layers? {
        guard width > 0, let plan = FacePlan(boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        let share = min(1, CGFloat(layerWidth) / CGFloat(width))
        let size = CGSize(width: CGFloat(width) * share, height: CGFloat(height) * share)
        let piece = newest.map { plan.area.piece(of: $0) }
        func layer(_ draw: @escaping (CGContext) -> Void) -> UIImage {
            renderer(size, opaque: false).image { context in
                context.cgContext.scaleBy(x: share, y: share)
                draw(context.cgContext)
            }
        }
        let still = layer { context in
            paintYellow(piece == nil ? boxes : older, cell: cell)
            plan.drawFaces(in: context, where: { $0 != piece })
        }
        guard let piece else { return Layers(still: still, fresh: nil, anchor: .center) }
        let fresh = layer { context in
            paintYellow(boxes.filter { plan.area.piece(of: $0) == piece }, cell: cell)
            plan.drawFaces(in: context, where: { $0 == piece })
        }
        let centre = plan.spots[piece].centre
        return Layers(still: still, fresh: fresh, anchor: UnitPoint(x: centre.x / CGFloat(width), y: centre.y / CGFloat(height)))
    }

    private static func renderer(_ size: CGSize, opaque: Bool) -> UIGraphicsImageRenderer {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = opaque
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format)
    }

    /// One rounded box around each box, so the yellow covers every sealed cell, with a smooth edge.
    private static func paintYellow(_ boxes: [GridBox], cell: Int) {
        yellow.setFill()
        let past = CGFloat(cell * reach)
        for box in boxes {
            UIBezierPath(roundedRect: CGRect(x: box.x, y: box.y, width: box.width, height: box.height).insetBy(dx: -past, dy: -past),
                         cornerRadius: past).fill()
        }
    }
}

/// Where each piece's face goes.
private struct FacePlan {
    let face: UIImage
    let area: CellArea
    let spots: [(centre: CGPoint, half: CGFloat)]

    init?(boxes: [GridBox], width: Int, height: Int, cell: Int) {
        guard cell > 0, width > 0, height > 0, let face = UIImage(named: "AreaFace"), let outline = FaceOutline(face),
              let area = CellArea(boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        self.face = face
        self.area = area
        spots = area.pieces.indices.map { area.largestSpot(inPiece: $0, for: outline) }
    }

    func drawFaces(in context: CGContext, where chosen: (Int) -> Bool) {
        context.interpolationQuality = .high
        for (piece, spot) in spots.enumerated() where chosen(piece) {
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

/// Which cells are in the boxes, in separate pieces: cells that touch along a side are one piece.
private struct CellArea {
    let cell: CGFloat
    let columns: Int
    let rows: Int
    /// For each cell of the grid, the number of its piece plus 1, or 0 for a cell outside.
    private var label: [Int32]
    /// The cells of each piece.
    private(set) var pieces: [[Int]] = []

    init?(boxes: [GridBox], width: Int, height: Int, cell: Int) {
        self.cell = CGFloat(cell)
        let (columns, rows) = ((width + cell - 1) / cell, (height + cell - 1) / cell)
        self.columns = columns
        self.rows = rows
        var label = [Int32](repeating: 0, count: columns * rows)
        for box in boxes {
            for row in box.y / cell..<min((box.y + box.height + cell - 1) / cell, rows) {
                for column in box.x / cell..<min((box.x + box.width + cell - 1) / cell, columns) {
                    label[row * columns + column] = -1
                }
            }
        }
        for start in label.indices where label[start] == -1 {
            let number = Int32(pieces.count + 1)
            label[start] = number
            var piece: [Int] = []
            var waiting = [start]
            while let at = waiting.popLast() {
                piece.append(at)
                var next: [Int] = []
                if at >= columns { next.append(at - columns) }
                if at < columns * (rows - 1) { next.append(at + columns) }
                if at % columns > 0 { next.append(at - 1) }
                if at % columns < columns - 1 { next.append(at + 1) }
                for n in next where label[n] == -1 {
                    label[n] = number
                    waiting.append(n)
                }
            }
            pieces.append(piece)
        }
        self.label = label
        if pieces.isEmpty { return nil }
    }

    /// Which piece a box of the list is in. All of a box's cells touch, so its first cell tells.
    func piece(of box: GridBox) -> Int {
        Int(label[(box.y / Int(cell)) * columns + box.x / Int(cell)]) - 1
    }

    /// The piece's cells and those the yellow reaches past them. The face may grow to the yellow's edge.
    private func reachOf(_ piece: [Int]) -> [Bool] {
        let past = AreaPreview.reach
        var near = [Bool](repeating: false, count: columns * rows)
        for at in piece {
            let (column, row) = (at % columns, at / columns)
            for r in max(0, row - past)...min(rows - 1, row + past) {
                for c in max(0, column - past)...min(columns - 1, column + past) where (r - row) * (r - row) + (c - column) * (c - column) <= past * past {
                    near[r * columns + c] = true
                }
            }
        }
        return near
    }

    private func holds(_ x: CGFloat, _ y: CGFloat, in near: [Bool]) -> Bool {
        guard x >= 0, y >= 0 else { return false }
        let (column, row) = (Int(x / cell), Int(y / cell))
        return column < columns && row < rows && near[row * columns + column]
    }

    /// Whether the face, with half its picture's side this long, stays in the yellow. It also checks inside the edge.
    private func fits(_ outline: FaceOutline, _ centre: CGPoint, _ half: CGFloat, in near: [Bool]) -> Bool {
        for share in [1, 0.8, 0.5] as [CGFloat] {
            for point in outline.points where !holds(centre.x + point.x * half * share, centre.y + point.y * half * share, in: near) {
                return false
            }
        }
        return true
    }

    /// The place in one piece where the face can be largest, nearest the piece's middle among equals.
    /// It almost touches the yellow's edges.
    func largestSpot(inPiece index: Int, for outline: FaceOutline) -> (centre: CGPoint, half: CGFloat) {
        let piece = pieces[index]
        let near = reachOf(piece)
        func centre(of at: Int) -> CGPoint {
            CGPoint(x: (CGFloat(at % columns) + 0.5) * cell, y: (CGFloat(at / columns) + 0.5) * cell)
        }
        let middle = piece.reduce(CGPoint.zero) { sum, at in
            CGPoint(x: sum.x + centre(of: at).x / CGFloat(piece.count), y: sum.y + centre(of: at).y / CGFloat(piece.count))
        }
        var best: (centre: CGPoint, half: CGFloat, offMiddle: CGFloat)?
        let limit = max(CGFloat(columns), CGFloat(rows)) * cell
        for at in piece {
            let here = centre(of: at)
            let offMiddle = hypot(here.x - middle.x, here.y - middle.y)
            let known = best?.half ?? cell / 2
            guard fits(outline, here, known, in: near) else { continue }
            if fits(outline, here, known + 1, in: near) {
                var (low, high) = (known + 1, limit)
                while high - low > 1 {
                    let half = (low + high) / 2
                    if fits(outline, here, half, in: near) { low = half } else { high = half }
                }
                best = (here, low, offMiddle)
            } else if offMiddle < best?.offMiddle ?? .greatestFiniteMagnitude {
                best = (here, known, offMiddle)
            }
        }
        // A thin piece may not hold even the smallest face. Then it takes one cell's size at the piece's middle.
        guard let best else { return (middle, cell / 2) }
        return (best.centre, best.half * 0.98)
    }
}
