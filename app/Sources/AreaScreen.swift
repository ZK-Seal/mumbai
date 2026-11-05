import PhotosUI
import SwiftUI

/// The first screen: choose a photo, then draw a box on it with a finger.
struct AreaScreen: View {
    /// The grid the box snaps to, in photo pixels.
    @AppStorage("cellSize") private var cellSize = 16

    @State private var pick: PhotosPickerItem?
    @State private var photo: UIImage?
    @State private var problem: String?
    // The finger's two points, in photo pixels. The box is worked out from them, so it follows the cell size.
    @State private var start: CGPoint?
    @State private var end: CGPoint?

    private var photoWidth: Int { photo.map { Int($0.size.width * $0.scale) } ?? 0 }
    private var photoHeight: Int { photo.map { Int($0.size.height * $0.scale) } ?? 0 }

    private var box: GridBox? {
        guard let start, let end else { return nil }
        return GridBox.snapped(from: start, to: end, photoWidth: photoWidth, photoHeight: photoHeight, cell: cellSize)
    }

    private var boxLine: String {
        guard photo != nil else { return problem ?? "No photo yet." }
        guard let box else { return "Draw a box on the photo with a finger." }
        return "Box: \(box.width) x \(box.height) at \(box.x), \(box.y) in a \(photoWidth) x \(photoHeight) photo"
    }

    var body: some View {
        VStack(spacing: 16) {
            PhotosPicker("Choose a sample photo", selection: $pick, matching: .images)
            Spacer(minLength: 0)
            if let photo {
                canvas(photo)
            }
            Spacer(minLength: 0)
            Text(boxLine)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("boxLine")
            Stepper("Cell size: \(cellSize) px", value: $cellSize, in: 8...64, step: 8)
            Button("Clear box") { clearBox() }
                .disabled(box == nil)
        }
        .padding(16)
        .task(id: pick) { await load() }
    }

    /// The photo, the area that takes the finger, and the box on top.
    private func canvas(_ photo: UIImage) -> some View {
        Image(uiImage: photo)
            .resizable()
            .scaledToFit()
            .overlay {
                GeometryReader { view in
                    let pixelsPerPoint = CGFloat(photoWidth) / max(view.size.width, 1)
                    ZStack(alignment: .topLeading) {
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                                start = CGPoint(x: drag.startLocation.x * pixelsPerPoint, y: drag.startLocation.y * pixelsPerPoint)
                                end = CGPoint(x: drag.location.x * pixelsPerPoint, y: drag.location.y * pixelsPerPoint)
                            })
                        if let box {
                            Rectangle()
                                .fill(.black.opacity(0.35))
                                .overlay(Rectangle().stroke(.yellow, lineWidth: 2))
                                .frame(width: CGFloat(box.width) / pixelsPerPoint, height: CGFloat(box.height) / pixelsPerPoint)
                                .offset(x: CGFloat(box.x) / pixelsPerPoint, y: CGFloat(box.y) / pixelsPerPoint)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
            .accessibilityIdentifier("photo")
    }

    private func clearBox() {
        start = nil
        end = nil
    }

    private func load() async {
        guard let pick else { return }
        clearBox()
        photo = nil
        problem = nil
        let data = try? await pick.loadTransferable(type: Data.self)
        photo = data.flatMap { UIImage(data: $0) }
        if photo == nil {
            problem = "Could not read this photo."
        }
    }
}
