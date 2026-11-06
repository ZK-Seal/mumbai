import UIKit

enum AreaPreview {
    /// A tile's side, as a share of the picture's long side.
    private static let tileShare = 0.03

    /// Mosaic tiles in the boxes. A tile's side is that share, in whole cells: 80 px at 2600 px.
    /// Each colour comes from the cells outside the boxes: a smooth mix, and one nearby outside cell.
    static func mosaic(_ image: UIImage, boxes: [GridBox], cell: Int) -> UIImage? {
        guard var picture = RawPixels(image), let area = CellArea(boxes: boxes, picture: picture, cell: cell) else { return nil }
        let (width, height) = (picture.width, picture.height)
        let tile = max(Int((Double(max(width, height)) * tileShare / Double(cell)).rounded()), 2)
        for channel in 0..<3 {
            let coarse = picture.cellColours(area, channel: channel)
            for row in 0..<area.rows {
                for column in 0..<area.columns where area.isIn(column, row) {
                    let (tileColumn, tileRow) = (column / tile, row / tile)
                    let colour = area.tileColour(coarse, tileColumn: tileColumn, tileRow: tileRow, tile: tile)
                    for y in row * cell..<min((row + 1) * cell, height) {
                        for x in column * cell..<min((column + 1) * cell, width) {
                            picture.bytes[(y * width + x) * 4 + channel] = UInt8(max(0, min(255, colour + 0.5)))
                        }
                    }
                }
            }
        }
        return picture.image()
    }

    /// A fixed, well-stirred number for a place. It depends only on the two numbers given.
    fileprivate static func mixedNumber(_ x: Int, _ y: Int) -> UInt32 {
        var mixed = UInt32(truncatingIfNeeded: x &* 73856093 ^ y &* 19349663)
        mixed ^= mixed >> 13
        mixed = mixed &* 1274126177
        mixed ^= mixed >> 16
        mixed = mixed &* 2246822519
        mixed ^= mixed >> 13
        return mixed
    }
}

/// Which cells are in the boxes.
private struct CellArea {
    let cell: Int
    let columns: Int
    let rows: Int
    private let marked: [Bool]

    init?(boxes: [GridBox], picture: RawPixels, cell: Int) {
        guard cell > 0 else { return nil }
        self.cell = cell
        columns = (picture.width + cell - 1) / cell
        rows = (picture.height + cell - 1) / cell
        var marks = [Bool](repeating: false, count: columns * rows)
        for box in boxes {
            for row in box.y / cell..<min((box.y + box.height + cell - 1) / cell, rows) {
                for column in box.x / cell..<min((box.x + box.width + cell - 1) / cell, columns) {
                    marks[row * columns + column] = true
                }
            }
        }
        marked = marks
    }

    func isIn(_ column: Int, _ row: Int) -> Bool { marked[row * columns + column] }
    func contains(_ x: Int, _ y: Int) -> Bool { marked[(y / cell) * columns + x / cell] }

    /// A tile's colour: half the smooth colours of its cells in the area, half one outside cell near it.
    /// Which outside cell depends only on where the tile is.
    func tileColour(_ coarse: [Float], tileColumn: Int, tileRow: Int, tile: Int) -> Float {
        var sum: Float = 0
        var count: Float = 0
        for row in tileRow * tile..<min((tileRow + 1) * tile, rows) {
            for column in tileColumn * tile..<min((tileColumn + 1) * tile, columns) where isIn(column, row) {
                sum += coarse[row * columns + column]
                count += 1
            }
        }
        let smooth = sum / max(count, 1)
        let directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        let turn = Int(AreaPreview.mixedNumber(tileColumn, tileRow) % 4)
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
}

/// A picture's pixels as four bytes each, red first, top row first.
private struct RawPixels {
    let width: Int
    let height: Int
    var bytes: [UInt8]

    private static let info = CGImageAlphaInfo.noneSkipLast.rawValue

    init?(_ image: UIImage) {
        guard let picture = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        width = picture.width
        height = picture.height
        bytes = [UInt8](repeating: 0, count: width * height * 4)
        let (w, h) = (width, height)
        let drew: Bool = bytes.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w * 4, space: space, bitmapInfo: Self.info) else { return false }
            context.draw(picture, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drew else { return nil }
    }

    /// One colour for each cell. A cell outside the area takes the mean of its own pixels. A cell in the area
    /// starts from the mean of those, then settles to the mean of its neighbours, so it reads no pixel of its own.
    func cellColours(_ area: CellArea, channel: Int) -> [Float] {
        let (columns, rows, cell) = (area.columns, area.rows, area.cell)
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

    func image() -> UIImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: Data(bytes) as CFData),
              let made = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                 space: space, bitmapInfo: CGBitmapInfo(rawValue: Self.info), provider: provider, decode: nil,
                                 shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: made)
    }
}
