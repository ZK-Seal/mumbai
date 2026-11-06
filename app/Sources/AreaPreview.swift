import SwiftUI
import UIKit

/// What covers the area on the screen. Both are drawn by this app. In the sealed file the area is grey under both.
enum Cover: String {
    case mask
    case mosaic
}

enum AreaPreview {
    /// The main yellow of the face's picture. The mask's area is filled with it.
    fileprivate static let yellow = UIColor(red: 185 / 255, green: 137 / 255, blue: 6 / 255, alpha: 1)
    /// How many cells the cover reaches past the sealed cells. This rounds its edge and covers every corner.
    fileprivate static let reach = 2
    /// The width of the drawing screen's layers: enough for the screen, and much lighter than the photo.
    private static let layerWidth = 1100

    /// The drawing screen's two clear layers. The new shape's layer can arrive softly over the others.
    struct Layers {
        let still: UIImage
        let fresh: UIImage?
        let anchor: UnitPoint
    }

    /// The result: the picture with its area covered.
    static func covered(_ image: UIImage, boxes: [GridBox], cell: Int, cover: Cover = .mask) -> UIImage? {
        let (width, height) = (Int(image.size.width * image.scale), Int(image.size.height * image.scale))
        guard let painter = Painter(cover: cover, image: image, boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        let size = CGSize(width: width, height: height)
        return renderer(size, opaque: true).image { context in
            image.draw(in: CGRect(origin: .zero, size: size))
            painter.paint(boxes, pieces: { _ in true }, in: context.cgContext)
        }
    }

    /// The same cover, with no photo in the layers, for the drawing screen. `older` is the area before the newest shape.
    /// The piece that holds `newest` goes on the fresh layer, and all the rest on the still one.
    static func layers(_ image: UIImage, boxes: [GridBox], older: [GridBox], newest: GridBox?, cell: Int, cover: Cover) -> Layers? {
        let (width, height) = (Int(image.size.width * image.scale), Int(image.size.height * image.scale))
        guard width > 0, let painter = Painter(cover: cover, image: image, boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        let share = min(1, CGFloat(layerWidth) / CGFloat(width))
        let size = CGSize(width: CGFloat(width) * share, height: CGFloat(height) * share)
        let piece = newest.map { painter.area.piece(of: $0) }
        func layer(_ draw: @escaping (CGContext) -> Void) -> UIImage {
            renderer(size, opaque: false).image { context in
                context.cgContext.scaleBy(x: share, y: share)
                draw(context.cgContext)
            }
        }
        let still = layer { context in
            painter.paint(piece == nil ? boxes : older, pieces: { $0 != piece }, in: context)
        }
        guard let piece else { return Layers(still: still, fresh: nil, anchor: .center) }
        let fresh = layer { context in
            painter.paint(boxes.filter { painter.area.piece(of: $0) == piece }, pieces: { $0 == piece }, in: context)
        }
        let centre = painter.centre(ofPiece: piece)
        return Layers(still: still, fresh: fresh, anchor: UnitPoint(x: centre.x / CGFloat(width), y: centre.y / CGFloat(height)))
    }

    private static func renderer(_ size: CGSize, opaque: Bool) -> UIGraphicsImageRenderer {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = opaque
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format)
    }
}

/// Draws one cover. The mask reads no pixel of the picture. The mosaic reads only pixels outside the area.
private struct Painter {
    private enum Look {
        case mask(face: UIImage, spots: [(centre: CGPoint, half: CGFloat)])
        case mosaic(tiles: UIImage, side: CGFloat)
    }

    let area: CellArea
    private let look: Look

    init?(cover: Cover, image: UIImage, boxes: [GridBox], width: Int, height: Int, cell: Int) {
        guard cell > 0, width > 0, height > 0, let area = CellArea(boxes: boxes, width: width, height: height, cell: cell) else { return nil }
        self.area = area
        switch cover {
        case .mask:
            guard let face = UIImage(named: "AreaFace"), let outline = FaceOutline(face) else { return nil }
            look = .mask(face: face, spots: area.pieces.indices.map { area.largestSpot(inPiece: $0, for: outline) })
        case .mosaic:
            guard let tiles = Mosaic.tiles(image, area: area, width: width, height: height) else { return nil }
            look = .mosaic(tiles: tiles.image, side: tiles.side)
        }
    }

    func centre(ofPiece piece: Int) -> CGPoint {
        if case .mask(_, let spots) = look { return spots[piece].centre }
        return area.middle(ofPiece: piece)
    }

    /// One rounded box around each box, so the cover reaches every sealed cell, with a smooth edge.
    func paint(_ boxes: [GridBox], pieces chosen: (Int) -> Bool, in context: CGContext) {
        let past = area.cell * CGFloat(AreaPreview.reach)
        let edge = UIBezierPath()
        for box in boxes {
            edge.append(UIBezierPath(roundedRect: CGRect(x: box.x, y: box.y, width: box.width, height: box.height).insetBy(dx: -past, dy: -past),
                                     cornerRadius: past))
        }
        switch look {
        case .mask(let face, let spots):
            AreaPreview.yellow.setFill()
            edge.fill()
            context.interpolationQuality = .high
            for (piece, spot) in spots.enumerated() where chosen(piece) {
                face.draw(in: CGRect(x: spot.centre.x - spot.half, y: spot.centre.y - spot.half, width: 2 * spot.half, height: 2 * spot.half))
            }
        case .mosaic(let tiles, let side):
            context.saveGState()
            edge.addClip()
            context.interpolationQuality = .none
            tiles.draw(in: CGRect(x: 0, y: 0, width: tiles.size.width * side, height: tiles.size.height * side))
            context.restoreGState()
        }
    }
}

/// The mosaic's colours, as a tiny picture with one pixel for each tile.
private enum Mosaic {
    /// A tile's side, as a share of the picture's long side.
    private static let tileShare = 0.03

    static func tiles(_ image: UIImage, area: CellArea, width: Int, height: Int) -> (image: UIImage, side: CGFloat)? {
        guard let picture = RawPixels(image), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let tile = max(Int((Double(max(width, height)) * tileShare / Double(area.cellSize)).rounded()), 2)
        let (across, down) = ((area.columns + tile - 1) / tile, (area.rows + tile - 1) / tile)
        var bytes = [UInt8](repeating: 255, count: across * down * 4)
        for channel in 0..<3 {
            let coarse = picture.cellColours(area, channel: channel)
            for row in 0..<down {
                for column in 0..<across {
                    let colour = area.tileColour(coarse, tileColumn: column, tileRow: row, tile: tile)
                    bytes[(row * across + column) * 4 + channel] = UInt8(max(0, min(255, colour + 0.5)))
                }
            }
        }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let made = CGImage(width: across, height: down, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: across * 4, space: space,
                                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil,
                                 shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        return (UIImage(cgImage: made), CGFloat(tile * area.cellSize))
    }

    /// A fixed, well-stirred number for a place. It depends only on the two numbers given.
    static func mixedNumber(_ x: Int, _ y: Int) -> UInt32 {
        var mixed = UInt32(truncatingIfNeeded: x &* 73856093 ^ y &* 19349663)
        mixed ^= mixed >> 13
        mixed = mixed &* 1274126177
        mixed ^= mixed >> 16
        mixed = mixed &* 2246822519
        mixed ^= mixed >> 13
        return mixed
    }
}

/// A picture's pixels as four bytes each, red first, top row first.
private struct RawPixels {
    let width: Int
    let height: Int
    var bytes: [UInt8]

    init?(_ image: UIImage) {
        guard let picture = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        width = picture.width
        height = picture.height
        bytes = [UInt8](repeating: 0, count: width * height * 4)
        let (w, h) = (width, height)
        let drew: Bool = bytes.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.draw(picture, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drew else { return nil }
    }

    /// One colour for each cell. A cell outside the area takes the mean of its own pixels. A cell in the area
    /// starts from the mean of those, then settles to the mean of its neighbours, so it reads no pixel of its own.
    func cellColours(_ area: CellArea, channel: Int) -> [Float] {
        let (columns, rows, cell) = (area.columns, area.rows, area.cellSize)
        var colours = [Float](repeating: 128, count: columns * rows)
        var total: Float = 0
        var known = 0
        for row in 0..<rows {
            for column in 0..<columns where !area.isIn(column, row) {
                var sum = 0
                var count = 0
                for y in row * cell..<min((row + 1) * cell, height) {
                    for x in column * cell..<min((column + 1) * cell, width) {
                        sum += Int(bytes[(y * width + x) * 4 + channel])
                        count += 1
                    }
                }
                colours[row * columns + column] = Float(sum) / Float(max(count, 1))
                total += colours[row * columns + column]
                known += 1
            }
        }
        // With no cell outside the area, there is nothing to draw from, so it stays plain grey.
        guard known > 0 else { return colours }
        for row in 0..<rows {
            for column in 0..<columns where area.isIn(column, row) {
                colours[row * columns + column] = total / Float(known)
            }
        }
        for _ in 0..<500 {
            var biggest: Float = 0
            for row in 0..<rows {
                for column in 0..<columns where area.isIn(column, row) {
                    var sum: Float = 0
                    var count: Float = 0
                    if row > 0 { sum += colours[(row - 1) * columns + column]; count += 1 }
                    if row < rows - 1 { sum += colours[(row + 1) * columns + column]; count += 1 }
                    if column > 0 { sum += colours[row * columns + column - 1]; count += 1 }
                    if column < columns - 1 { sum += colours[row * columns + column + 1]; count += 1 }
                    let next = sum / max(count, 1)
                    biggest = max(biggest, abs(next - colours[row * columns + column]))
                    colours[row * columns + column] = next
                }
            }
            if biggest < 0.25 { break }
        }
        return colours
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
    let cellSize: Int
    let columns: Int
    let rows: Int
    /// For each cell of the grid, the number of its piece plus 1, or 0 for a cell outside.
    private var label: [Int32]
    /// The cells of each piece.
    private(set) var pieces: [[Int]] = []

    init?(boxes: [GridBox], width: Int, height: Int, cell: Int) {
        self.cell = CGFloat(cell)
        cellSize = cell
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

    func isIn(_ column: Int, _ row: Int) -> Bool { label[row * columns + column] != 0 }

    func middle(ofPiece index: Int) -> CGPoint {
        let piece = pieces[index]
        return piece.reduce(CGPoint.zero) { sum, at in
            CGPoint(x: sum.x + (CGFloat(at % columns) + 0.5) * cell / CGFloat(piece.count),
                    y: sum.y + (CGFloat(at / columns) + 0.5) * cell / CGFloat(piece.count))
        }
    }

    /// A tile's colour: half the smooth colours of its cells in the area, half one outside cell near it.
    /// Which outside cell depends only on where the tile is. A tile with no cell in the area, in the rounded
    /// margin past it, takes all its cells instead.
    func tileColour(_ coarse: [Float], tileColumn: Int, tileRow: Int, tile: Int) -> Float {
        var (inside, insideCount, all, allCount): (Float, Float, Float, Float) = (0, 0, 0, 0)
        for row in tileRow * tile..<min((tileRow + 1) * tile, rows) {
            for column in tileColumn * tile..<min((tileColumn + 1) * tile, columns) {
                all += coarse[row * columns + column]
                allCount += 1
                if isIn(column, row) {
                    inside += coarse[row * columns + column]
                    insideCount += 1
                }
            }
        }
        let smooth = insideCount > 0 ? inside / insideCount : all / max(allCount, 1)
        let directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        let turn = Int(Mosaic.mixedNumber(tileColumn, tileRow) % 4)
        var (column, row) = (tileColumn * tile + tile / 2, tileRow * tile + tile / 2)
        while column >= 0, row >= 0, column < columns, row < rows {
            if !isIn(column, row) {
                return smooth * 0.5 + coarse[row * columns + column] * 0.5
            }
            column += directions[turn].0
            row += directions[turn].1
        }
        return smooth
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
        let middle = middle(ofPiece: index)
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
