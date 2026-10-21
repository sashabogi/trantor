import SwiftUI

// The ibkr "stage" palette (ibkr ui/src/theme/tokens.css, the Trading Dock Refit Sasha approved
// 2026-10-02): deep navy stage, soft radial light, mint accent, mono digits. Nothing outside this
// file defines a color.

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: opacity)
    }
}

public enum Palette {
    // Surfaces, darkest to lightest
    public static let ground = Color(hex: 0x060912)
    public static let stage = Color(hex: 0x0B1020)
    public static let ink = Color(hex: 0x0D1117)
    public static let panel = Color(hex: 0x0D1325)
    public static let panel2 = Color(hex: 0x111930)
    public static let raise = Color(hex: 0x172140)
    public static let chrome = Color(hex: 0x0D1325, opacity: 0.6)

    // Lines (140,162,214 at rising alpha)
    public static let hairline = Color(hex: 0x8CA2D6, opacity: 0.08)
    public static let line2 = Color(hex: 0x8CA2D6, opacity: 0.15)
    public static let line3 = Color(hex: 0x8CA2D6, opacity: 0.24)

    // Text
    public static let text = Color(hex: 0xE8EDF7)
    public static let text2 = Color(hex: 0xAEB8CF)
    public static let textDim = Color(hex: 0x71809E)
    public static let textFaint = Color(hex: 0x4A5672)

    // Semantic
    public static let up = Color(hex: 0x26C6A8)
    public static let down = Color(hex: 0xEF5A6F)
    public static let accent = Color(hex: 0x3EF0C2)
    public static let accentSoft = Color(hex: 0x3EF0C2, opacity: 0.12)
    public static let onAccent = Color(hex: 0x04261E)
    public static let onDown = Color(hex: 0x1D0509)
    public static let amber = Color(hex: 0xF5B301)
    public static let warn = Color(hex: 0xB45309)
    public static let live = Color(hex: 0x22C55E)
    public static let window = Color(hex: 0x7F9CFF)
    public static let vwap = Color(hex: 0x9FB4FF)

    // Link-group hues, used to tell seats and projects apart
    public static let red = Color(hex: 0xF06272)
    public static let orange = Color(hex: 0xF08A3C)
    public static let yellow = Color(hex: 0xE8C547)
    public static let green = Color(hex: 0x3CCF7A)
    public static let blue = Color(hex: 0x4F8CFF)
    public static let purple = Color(hex: 0xA879F2)

    public static let hues: [Color] = [blue, purple, green, orange, yellow, red, vwap]

    /// A stable hue for a name: the same seat or project is always the same color.
    public static func hue(for name: String) -> Color {
        var h: UInt32 = 2166136261
        for b in name.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        return hues[Int(h % UInt32(hues.count))]
    }
}

public enum Space {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24
}

public enum Radius {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 6
    public static let md: CGFloat = 8
    public static let lg: CGFloat = 12
}

public enum Motion {
    /// cubic-bezier(0.2, 0.7, 0.3, 1)
    public static let ease = Animation.timingCurve(0.2, 0.7, 0.3, 1, duration: 0.22)
    public static let flash = Animation.easeOut(duration: 0.6)
}
