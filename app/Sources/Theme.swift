import SwiftUI

/// The app's colours and fonts, in one place, for light and dark.
enum Theme {
    private static func colour(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                           blue: CGFloat(value & 0xff) / 255, alpha: 1)
        })
    }

    static let accent = colour(0x8a5a1a, 0xdcab64)
    static let onAccent = colour(0xffffff, 0x0e1626)
    static let background = colour(0xf8f7f3, 0x0e1626)
    static let surface = colour(0xffffff, 0x152036)
    static let muted = colour(0x63656d, 0x939bad)
    static let line = colour(0xd3d1ca, 0x283349)
    static let refused = colour(0x9a2a1f, 0xff9f92)
    static let refusedBackground = colour(0xfbe8e5, 0x301614)
    static let waiting = colour(0xb86b1d, 0xf2b46b)
    static let waitingBackground = colour(0xfbefdf, 0x33261a)

    /// Text. It grows and shrinks with the phone's text size.
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Public Sans", size: size, relativeTo: style(size)).weight(weight)
    }

    private static func style(_ size: CGFloat) -> Font.TextStyle {
        switch size {
        case 20...: return .title2
        case 17..<20: return .body
        case 15..<17: return .subheadline
        case 13..<15: return .footnote
        default: return .caption
        }
    }

    /// The words of the one main button on a screen.
    static func mainLabel<Words: View>(_ words: Words) -> some View {
        words.font(Theme.text(17, .semibold))
            .foregroundStyle(onAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }
}
