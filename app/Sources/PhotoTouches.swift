import SwiftUI
import UIKit

/// Takes the touches on the photo. One finger draws. Two fingers zoom and move. Two quick taps go back to fit.
/// Points go out in the photo's own frame at fit size, whatever the zoom.
struct PhotoTouches: UIViewRepresentable {
    @Binding var zoom: CGFloat
    @Binding var pan: CGSize
    let canDraw: Bool
    let lineStarted: () -> Void
    let linePoint: (CGPoint) -> Void
    let lineEnded: () -> Void
    let lineDropped: () -> Void

    func makeUIView(context: Context) -> Surface {
        let surface = Surface()
        surface.backgroundColor = .clear
        surface.isMultipleTouchEnabled = true
        return surface
    }

    func updateUIView(_ surface: Surface, context: Context) {
        surface.touches = self
    }

    final class Surface: UIView {
        var touches: PhotoTouches?

        private enum Mode {
            case idle
            case line(UITouch)
            case twoFingers(UITouch, UITouch)
            /// Fingers are still down, but this gesture is over.
            case waiting
        }

        private var mode = Mode.idle
        private var lineStart = (time: TimeInterval(0), at: CGPoint.zero)
        private var lineLength: CGFloat = 0
        private var lastPoint = CGPoint.zero
        private var pinchStart = (distance: CGFloat(1), middle: CGPoint.zero, zoom: CGFloat(1), pan: CGSize.zero)
        private var lastTap = (time: TimeInterval(0), at: CGPoint.zero)

        private static let mostZoom: CGFloat = 5
        /// A second finger this soon, or on a line this short, means the first was the start of a pinch.
        private static let pinchTime: TimeInterval = 0.3
        private static let pinchLine: CGFloat = 24
        private static let tapTime: TimeInterval = 0.25
        private static let tapMove: CGFloat = 10
        private static let doubleTapTime: TimeInterval = 0.35
        private static let doubleTapMove: CGFloat = 40

        /// From this view's own points to the photo's frame at fit size.
        private func photoPoint(_ point: CGPoint) -> CGPoint {
            let (zoom, pan) = (touches?.zoom ?? 1, touches?.pan ?? .zero)
            return CGPoint(x: (point.x - pan.width) / zoom, y: (point.y - pan.height) / zoom)
        }

        private func down(_ event: UIEvent?) -> [UITouch] {
            (event?.touches(for: self) ?? []).filter { $0.phase != .ended && $0.phase != .cancelled }
        }

        private func startPinch(_ first: UITouch, _ second: UITouch) {
            let (a, b) = (first.location(in: self), second.location(in: self))
            pinchStart = (max(hypot(a.x - b.x, a.y - b.y), 1), CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2),
                          touches?.zoom ?? 1, touches?.pan ?? .zero)
            mode = .twoFingers(first, second)
        }

        private func movePinch(_ first: UITouch, _ second: UITouch) {
            let (a, b) = (first.location(in: self), second.location(in: self))
            let middle = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            let zoom = min(max(pinchStart.zoom * hypot(a.x - b.x, a.y - b.y) / pinchStart.distance, 1), Self.mostZoom)
            // The photo point that was under the fingers' middle stays under it. The photo always fills the frame.
            let x = (pinchStart.middle.x - pinchStart.pan.width) / pinchStart.zoom
            let y = (pinchStart.middle.y - pinchStart.pan.height) / pinchStart.zoom
            touches?.zoom = zoom
            touches?.pan = CGSize(width: min(max(middle.x - x * zoom, bounds.width * (1 - zoom)), 0),
                                  height: min(max(middle.y - y * zoom, bounds.height * (1 - zoom)), 0))
        }

        override func touchesBegan(_ began: Set<UITouch>, with event: UIEvent?) {
            let now = down(event)
            switch mode {
            case .idle:
                if now.count >= 2 {
                    startPinch(now[0], now[1])
                } else if let touch = began.first {
                    let at = touch.location(in: self)
                    lineStart = (touch.timestamp, at)
                    lineLength = 0
                    lastPoint = at
                    mode = .line(touch)
                    if touches?.canDraw == true {
                        touches?.lineStarted()
                        touches?.linePoint(photoPoint(at))
                    }
                }
            case .line(let touch):
                guard let second = began.first(where: { $0 !== touch }) else { return }
                // Two fingers rarely land together. A line only just begun was the start of a pinch, so none of it stays.
                // A second touch on a line well under way is a resting hand, and the line goes on.
                if second.timestamp - lineStart.time < Self.pinchTime || lineLength < Self.pinchLine {
                    touches?.lineDropped()
                    startPinch(touch, second)
                }
            case .twoFingers, .waiting:
                break
            }
        }

        override func touchesMoved(_ moved: Set<UITouch>, with event: UIEvent?) {
            switch mode {
            case .line(let touch):
                guard moved.contains(touch) else { return }
                let at = touch.location(in: self)
                lineLength += hypot(at.x - lastPoint.x, at.y - lastPoint.y)
                lastPoint = at
                if touches?.canDraw == true { touches?.linePoint(photoPoint(at)) }
            case .twoFingers(let first, let second):
                movePinch(first, second)
            case .idle, .waiting:
                break
            }
        }

        override func touchesEnded(_ ended: Set<UITouch>, with event: UIEvent?) {
            finish(ended, event)
        }

        override func touchesCancelled(_ cancelled: Set<UITouch>, with event: UIEvent?) {
            finish(cancelled, event)
        }

        private func finish(_ gone: Set<UITouch>, _ event: UIEvent?) {
            switch mode {
            case .line(let touch) where gone.contains(touch):
                let isTap = touch.timestamp - lineStart.time < Self.tapTime && lineLength < Self.tapMove
                if isTap {
                    touches?.lineDropped()
                    tapped(at: lineStart.at, time: touch.timestamp)
                } else if touches?.canDraw == true {
                    touches?.lineEnded()
                }
                mode = .waiting
            case .twoFingers(let first, let second) where gone.contains(first) || gone.contains(second):
                mode = .waiting
            default:
                break
            }
            if down(event).isEmpty { mode = .idle }
        }

        private func tapped(at point: CGPoint, time: TimeInterval) {
            if time - lastTap.time < Self.doubleTapTime, hypot(point.x - lastTap.at.x, point.y - lastTap.at.y) < Self.doubleTapMove {
                withAnimation(.easeOut(duration: 0.2)) {
                    touches?.zoom = 1
                    touches?.pan = .zero
                }
                lastTap = (0, .zero)
            } else {
                lastTap = (time, point)
            }
        }
    }
}
