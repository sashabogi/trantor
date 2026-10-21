import CoreText
import SwiftUI

// Geist for chrome, JetBrains Mono with tabular digits for every number and id. Sizes are the
// ibkr scale lifted for a phone (12.5px desktop chrome reads as 15pt here) and follow Dynamic Type.

public enum Fonts {
    nonisolated(unsafe) private static var registered = false

    /// Registers the bundled faces once. Call before the first view draws.
    public static func register() {
        guard !registered else { return }
        registered = true
        let names = ["Geist-Regular", "Geist-Medium", "Geist-SemiBold", "Geist-Bold",
                     "JetBrainsMono-Regular", "JetBrainsMono-Medium", "JetBrainsMono-SemiBold", "JetBrainsMono-Bold"]
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
                    ?? Bundle.module.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func geist(_ weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "Geist-Bold"
        case .semibold: return "Geist-SemiBold"
        case .medium: return "Geist-Medium"
        default: return "Geist-Regular"
        }
    }

    static func mono(_ weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "JetBrainsMono-Bold"
        case .semibold: return "JetBrainsMono-SemiBold"
        case .medium: return "JetBrainsMono-Medium"
        default: return "JetBrainsMono-Regular"
        }
    }
}

extension Font {
    /// Geist at a size, scaling with the given text style.
    public static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(Fonts.geist(weight), size: size, relativeTo: style)
    }

    /// JetBrains Mono at a size. Pair with `.monospacedDigit()` where digits change.
    public static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(Fonts.mono(weight), size: size, relativeTo: style)
    }

    // The scale
    public static let tHero = Font.ui(30, .semibold, relativeTo: .largeTitle)
    public static let tTitle = Font.ui(22, .semibold, relativeTo: .title2)
    public static let tHeadline = Font.ui(16, .semibold, relativeTo: .headline)
    public static let tBody = Font.ui(15, .regular, relativeTo: .body)
    public static let tCallout = Font.ui(13.5, .regular, relativeTo: .callout)
    public static let tCaption = Font.ui(12, .regular, relativeTo: .caption)
    public static let tEyebrow = Font.mono(10.5, .medium, relativeTo: .caption2)
    public static let tData = Font.mono(13, .regular, relativeTo: .footnote)
    public static let tDataSmall = Font.mono(11.5, .regular, relativeTo: .caption)
    public static let tNumberHero = Font.mono(30, .medium, relativeTo: .largeTitle)
}

/// The uppercase, widely tracked mono label ibkr puts over every panel ("WATCHLIST", "INTER-MARKET").
public struct Eyebrow: View {
    let text: String
    var color: Color = Palette.textDim
    public init(_ text: String, color: Color = Palette.textDim) { self.text = text; self.color = color }
    public var body: some View {
        Text(text.uppercased())
            .font(.tEyebrow)
            .tracking(10.5 * 0.16)
            .foregroundStyle(color)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A number or id in mono with tabular digits.
public struct Mono: View {
    let text: String
    var font: Font = .tData
    var color: Color = Palette.text2
    public init(_ text: String, font: Font = .tData, color: Color = Palette.text2) {
        self.text = text; self.font = font; self.color = color
    }
    public var body: some View {
        Text(text).font(font).monospacedDigit().foregroundStyle(color)
    }
}
