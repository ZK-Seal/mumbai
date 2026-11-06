import UIKit

/// A smooth, round line around a set of grid boxes, for the screen only. Every sealed cell stays inside it.
/// It grows the cells, blurs them, and takes the line where the blur falls to a low value.
enum AreaOutline {
    /// Empty cells kept around the grid, so the line can pass beyond the photo's edge and always closes.
    private static let padding = 10
    private static let blurRadius = 4
    private static let blurWidth: Float = 1.2
    private static let lowValue: Float = 0.2
    private static let mostGrowth = 4

    static func path(around boxes: [GridBox], cell: Int, width: Int, height: Int) -> UIBezierPath {
        guard !boxes.isEmpty, cell > 0 else { return UIBezierPath() }
        let columns = (width + cell - 1) / cell + 2 * padding
        let rows = (height + cell - 1) / cell + 2 * padding
        var cells = [Bool](repeating: false, count: columns * rows)
        for box in boxes {
            for row in box.y / cell..<(box.y + box.height + cell - 1) / cell {
                for column in box.x / cell..<(box.x + box.width + cell - 1) / cell {
                    cells[(row + padding) * columns + column + padding] = true
                }
            }
        }
        for growth in 1...mostGrowth {
            let field = blurred(grown(cells, by: growth, columns, rows), columns, rows)
            let line = contour(field, columns, rows, cell: CGFloat(cell))
            if covers(boxes, cell: cell, line) { return line }
        }
        // This should not happen. A plain rounded box around each box always covers them.
        let safe = UIBezierPath()
        let past = CGFloat(cell * mostGrowth)
        for box in boxes {
            safe.append(UIBezierPath(roundedRect: CGRect(x: box.x, y: box.y, width: box.width, height: box.height).insetBy(dx: -past, dy: -past),
                                     cornerRadius: past))
        }
        return safe
    }

    /// Whether every outer corner of every box is inside the line.
    private static func covers(_ boxes: [GridBox], cell: Int, _ line: UIBezierPath) -> Bool {
        let path = line.cgPath
        func inside(_ x: Int, _ y: Int) -> Bool { path.contains(CGPoint(x: x, y: y), using: .evenOdd) }
        for box in boxes {
            for x in stride(from: box.x, through: box.x + box.width, by: cell) where !inside(x, box.y) || !inside(x, box.y + box.height) {
                return false
            }
            for y in stride(from: box.y, through: box.y + box.height, by: cell) where !inside(box.x, y) || !inside(box.x + box.width, y) {
                return false
            }
        }
        return true
    }

    private static func grown(_ cells: [Bool], by growth: Int, _ columns: Int, _ rows: Int) -> [Float] {
        var out = [Float](repeating: 0, count: cells.count)
        for row in 0..<rows {
            for column in 0..<columns where cells[row * columns + column] {
                for r in max(0, row - growth)...min(rows - 1, row + growth) {
                    for c in max(0, column - growth)...min(columns - 1, column + growth)
                    where (r - row) * (r - row) + (c - column) * (c - column) <= growth * growth {
                        out[r * columns + c] = 1
                    }
                }
            }
        }
        return out
    }

    private static func blurred(_ values: [Float], _ columns: Int, _ rows: Int) -> [Float] {
        var weights = (-blurRadius...blurRadius).map { exp(-Float($0 * $0) / (2 * blurWidth * blurWidth)) }
        let total = weights.reduce(0, +)
        weights = weights.map { $0 / total }
        var across = [Float](repeating: 0, count: values.count)
        for row in 0..<rows {
            for column in blurRadius..<columns - blurRadius {
                var sum: Float = 0
                for step in -blurRadius...blurRadius {
                    sum += values[row * columns + column + step] * weights[step + blurRadius]
                }
                across[row * columns + column] = sum
            }
        }
        var out = [Float](repeating: 0, count: values.count)
        for row in blurRadius..<rows - blurRadius {
            for column in 0..<columns {
                var sum: Float = 0
                for step in -blurRadius...blurRadius {
                    sum += across[(row + step) * columns + column] * weights[step + blurRadius]
                }
                out[row * columns + column] = sum
            }
        }
        return out
    }

    /// Walks the squares of the grid and joins the crossings of the low value into closed lines, each drawn as a smooth curve.
    private static func contour(_ field: [Float], _ columns: Int, _ rows: Int, cell: CGFloat) -> UIBezierPath {
        // Each edge of the grid has a number: across from a point is 2n, down from it is 2n + 1.
        var next = [Int32](repeating: -1, count: columns * rows * 2)
        var crossing = [CGPoint](repeating: .zero, count: columns * rows * 2)
        func place(_ column: CGFloat, _ row: CGFloat) -> CGPoint {
            CGPoint(x: (column - CGFloat(padding) + 0.5) * cell, y: (row - CGFloat(padding) + 0.5) * cell)
        }
        func share(_ a: Float, _ b: Float) -> CGFloat { CGFloat((lowValue - a) / (b - a)) }
        for row in 0..<rows - 1 {
            for column in 0..<columns - 1 {
                let at = row * columns + column
                let (a, b, c, d) = (field[at], field[at + 1], field[at + columns + 1], field[at + columns])
                let kind = (a >= lowValue ? 1 : 0) | (b >= lowValue ? 2 : 0) | (c >= lowValue ? 4 : 0) | (d >= lowValue ? 8 : 0)
                if kind == 0 || kind == 15 { continue }
                let (top, left) = (2 * at, 2 * at + 1)
                let (bottom, right) = (2 * (at + columns), 2 * (at + 1) + 1)
                if (a >= lowValue) != (b >= lowValue) { crossing[top] = place(CGFloat(column) + share(a, b), CGFloat(row)) }
                if (a >= lowValue) != (d >= lowValue) { crossing[left] = place(CGFloat(column), CGFloat(row) + share(a, d)) }
                if (d >= lowValue) != (c >= lowValue) { crossing[bottom] = place(CGFloat(column) + share(d, c), CGFloat(row + 1)) }
                if (b >= lowValue) != (c >= lowValue) { crossing[right] = place(CGFloat(column + 1), CGFloat(row) + share(b, c)) }
                let joined = (a + b + c + d) / 4 >= lowValue
                let steps: [(Int, Int)]
                switch kind {
                case 1: steps = [(left, top)]
                case 2: steps = [(top, right)]
                case 3: steps = [(left, right)]
                case 4: steps = [(right, bottom)]
                case 5: steps = joined ? [(right, top), (left, bottom)] : [(left, top), (right, bottom)]
                case 6: steps = [(top, bottom)]
                case 7: steps = [(left, bottom)]
                case 8: steps = [(bottom, left)]
                case 9: steps = [(bottom, top)]
                case 10: steps = joined ? [(top, left), (bottom, right)] : [(top, right), (bottom, left)]
                case 11: steps = [(bottom, right)]
                case 12: steps = [(right, left)]
                case 13: steps = [(right, top)]
                default: steps = [(top, left)]
                }
                for (from, to) in steps { next[from] = Int32(to) }
            }
        }
        let line = UIBezierPath()
        line.usesEvenOddFillRule = true
        for start in next.indices where next[start] >= 0 {
            var points: [CGPoint] = []
            var edge = start
            while next[edge] >= 0 {
                points.append(crossing[edge])
                let after = Int(next[edge])
                next[edge] = -1
                edge = after
            }
            guard points.count >= 3 else { continue }
            line.move(to: points[0])
            // A curve through every point, each bend set by the two points around it.
            let n = points.count
            for i in 0..<n {
                let (p0, p1, p2, p3) = (points[(i + n - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n])
                line.addCurve(to: p2,
                              controlPoint1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                              controlPoint2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6))
            }
            line.close()
        }
        return line
    }
}
