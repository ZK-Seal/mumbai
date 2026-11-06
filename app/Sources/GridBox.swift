/// A box in photo pixels. Its left and top edges sit on the grid. Its right and bottom
/// edges sit on the grid too, or on the photo's own right and bottom sides.
struct GridBox: Equatable {
    var x: Int
    var y: Int
    var width: Int
    var height: Int
}
