import CoreGraphics

/// A closed shape drawn with a finger, turned into whole cells of the grid.
/// Every cell the shape touches is in, so the cells cover all of it.
struct PenShape: Equatable {
    /// The cells as rectangles, in photo pixels. They do not overlap.
    let boxes: [GridBox]
    let cellCount: Int

    /// `path` is in photo pixels. Its last point joins its first, and a point outside the photo
    /// moves to the photo's edge. One point gives one cell.
    static func make(path: [CGPoint], photoWidth: Int, photoHeight: Int, cell: Int) -> PenShape? {
        guard cell > 0, photoWidth > 0, photoHeight > 0, !path.isEmpty,
              path.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        var grid = CellGrid(columns: (photoWidth + cell - 1) / cell, rows: (photoHeight + cell - 1) / cell)
        let size = CGFloat(cell)
        let points = path.map {
            CGPoint(x: min(max($0.x, 0), CGFloat(photoWidth - 1)), y: min(max($0.y, 0), CGFloat(photoHeight - 1)))
        }
        for (index, point) in points.enumerated() {
            grid.markLine(from: point, to: points[(index + 1) % points.count], cell: size)
        }
        grid.fillEnclosed()
        return PenShape(boxes: grid.rectangles(cell: cell, photoWidth: photoWidth, photoHeight: photoHeight),
                        cellCount: grid.marked.filter { $0 }.count)
    }

    /// Whether a closed line is large enough to hold one cell. A tap or a straight stroke is not.
    static func holdsACell(path: [CGPoint], photoWidth: Int, photoHeight: Int, cell: Int) -> Bool {
        let points = path.map {
            CGPoint(x: min(max($0.x, 0), CGFloat(photoWidth - 1)), y: min(max($0.y, 0), CGFloat(photoHeight - 1)))
        }
        var twice: CGFloat = 0
        for (index, point) in points.enumerated() {
            let next = points[(index + 1) % points.count]
            twice += point.x * next.y - next.x * point.y
        }
        return abs(twice) / 2 >= CGFloat(cell * cell)
    }

    /// The shapes as one: overlapping ones join, and no cell is listed twice.
    static func joined(_ shapes: [PenShape], photoWidth: Int, photoHeight: Int, cell: Int) -> PenShape? {
        guard !shapes.isEmpty, cell > 0, photoWidth > 0, photoHeight > 0 else { return nil }
        var grid = CellGrid(columns: (photoWidth + cell - 1) / cell, rows: (photoHeight + cell - 1) / cell)
        for box in shapes.flatMap(\.boxes) {
            for row in box.y / cell..<min((box.y + box.height + cell - 1) / cell, grid.rows) {
                for column in box.x / cell..<min((box.x + box.width + cell - 1) / cell, grid.columns) {
                    grid.marked[row * grid.columns + column] = true
                }
            }
        }
        return PenShape(boxes: grid.rectangles(cell: cell, photoWidth: photoWidth, photoHeight: photoHeight),
                        cellCount: grid.marked.filter { $0 }.count)
    }
}

/// Which cells of the grid are in the shape.
private struct CellGrid {
    let columns: Int
    let rows: Int
    var marked: [Bool]

    init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
        marked = Array(repeating: false, count: columns * rows)
    }

    /// Marks every cell the line passes through, one row of cells at a time.
    mutating func markLine(from a: CGPoint, to b: CGPoint, cell: CGFloat) {
        let (top, bottom) = a.y <= b.y ? (a, b) : (b, a)
        let firstRow = min(Int(top.y / cell), rows - 1)
        let lastRow = min(Int(bottom.y / cell), rows - 1)
        let slope = bottom.y > top.y ? (bottom.x - top.x) / (bottom.y - top.y) : 0
        for row in firstRow...lastRow {
            let enter = max(top.y, CGFloat(row) * cell)
            let leave = min(bottom.y, CGFloat(row + 1) * cell)
            // A level line has no slope, so it spans its own two ends.
            let x0 = bottom.y > top.y ? top.x + (enter - top.y) * slope : top.x
            let x1 = bottom.y > top.y ? top.x + (leave - top.y) * slope : bottom.x
            let first = min(Int(min(x0, x1) / cell), columns - 1)
            let last = min(Int(max(x0, x1) / cell), columns - 1)
            for column in first...last {
                marked[row * columns + column] = true
            }
        }
    }

    /// Marks every cell that the outside of the photo cannot reach without crossing a marked cell.
    mutating func fillEnclosed() {
        var outside = Array(repeating: false, count: marked.count)
        var waiting: [Int] = []
        func isEdge(_ i: Int) -> Bool {
            i < columns || i >= columns * (rows - 1) || i % columns == 0 || i % columns == columns - 1
        }
        for i in marked.indices where isEdge(i) && !marked[i] {
            outside[i] = true
            waiting.append(i)
        }
        while let i = waiting.popLast() {
            var next: [Int] = []
            if i >= columns { next.append(i - columns) }
            if i < columns * (rows - 1) { next.append(i + columns) }
            if i % columns > 0 { next.append(i - 1) }
            if i % columns < columns - 1 { next.append(i + 1) }
            for n in next where !marked[n] && !outside[n] {
                outside[n] = true
                waiting.append(n)
            }
        }
        for i in marked.indices where !outside[i] {
            marked[i] = true
        }
    }

    /// The marked cells as rectangles: runs along each row, joined with the same run in the row above.
    func rectangles(cell: Int, photoWidth: Int, photoHeight: Int) -> [GridBox] {
        var boxes: [GridBox] = []
        // For each run still growing: its first and last column, and where its box is.
        var open: [[Int]: Int] = [:]
        for row in 0..<rows {
            var stillOpen: [[Int]: Int] = [:]
            var column = 0
            while column < columns {
                guard marked[row * columns + column] else {
                    column += 1
                    continue
                }
                var end = column
                while end + 1 < columns, marked[row * columns + end + 1] {
                    end += 1
                }
                let bottom = min((row + 1) * cell, photoHeight)
                if let index = open[[column, end]] {
                    boxes[index].height = bottom - boxes[index].y
                    stillOpen[[column, end]] = index
                } else {
                    let right = min((end + 1) * cell, photoWidth)
                    boxes.append(GridBox(x: column * cell, y: row * cell, width: right - column * cell, height: bottom - row * cell))
                    stillOpen[[column, end]] = boxes.count - 1
                }
                column = end + 1
            }
            open = stillOpen
        }
        return boxes
    }
}
