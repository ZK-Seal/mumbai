import CoreGraphics

/// A box in photo pixels. Its left and top edges sit on the grid. Its right and bottom
/// edges sit on the grid too, or on the photo's own right and bottom sides.
struct GridBox: Equatable {
    var x: Int
    var y: Int
    var width: Int
    var height: Int

    /// The smallest box on the grid that covers everything between two finger points.
    /// The points are in photo pixels and may lie outside the photo. A tap gives one cell.
    static func snapped(from a: CGPoint, to b: CGPoint, photoWidth: Int, photoHeight: Int, cell: Int) -> GridBox? {
        guard cell > 0, photoWidth > 0, photoHeight > 0,
              a.x.isFinite, a.y.isFinite, b.x.isFinite, b.y.isFinite else { return nil }
        let (left, right) = edges(a.x, b.x, side: photoWidth, cell: cell)
        let (top, bottom) = edges(a.y, b.y, side: photoHeight, cell: cell)
        return GridBox(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// One axis: the low edge rounds down to the grid, the high edge rounds up to it,
    /// and the high edge stops at the side of the photo.
    private static func edges(_ p: CGFloat, _ q: CGFloat, side: Int, cell: Int) -> (Int, Int) {
        let size = CGFloat(side)
        let low = Int(min(max(min(p, q), 0), size - 1).rounded(.down))
        let high = Int(min(max(max(p, q), 0), size).rounded(.up))
        let from = low / cell * cell
        let to = max((high + cell - 1) / cell * cell, from + cell)
        return (from, min(to, side))
    }
}
