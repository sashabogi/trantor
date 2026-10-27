import SwiftUI

private struct AuroraReduceTransparencyKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Allows a gallery or snapshot to exercise the solid variant without changing system settings.
    public var auroraReduceTransparency: Bool {
        get { self[AuroraReduceTransparencyKey.self] }
        set { self[AuroraReduceTransparencyKey.self] = newValue }
    }
}

public enum AuroraState: String, CaseIterable, Sendable {
    case clear, waiting, failed

    public init(hasWaiting: Bool, hasFailed: Bool) {
        self = hasFailed ? .failed : hasWaiting ? .waiting : .clear
    }

    public var label: String {
        switch self {
        case .clear: return "All clear"
        case .waiting: return "Waiting for you"
        case .failed: return "Failed"
        }
    }
}

/// One static background per screen. Elliptical lights follow the available bounds.
public struct AuroraBackground: View {
    let state: AuroraState
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    @Environment(\.auroraReduceTransparency) private var previewReduceTransparency
    private var reduceTransparency: Bool { systemReduceTransparency || previewReduceTransparency }
    public init(state: AuroraState) { self.state = state }

    public var body: some View {
        GeometryReader { geometry in
            ZStack {
                Palette.auroraGround
                light(Glow.primary(state), strength: Glow.primaryStrength, x: 0.12, y: 0.18, size: geometry.size)
                light(Glow.secondary, strength: Glow.secondaryStrength, x: 0.70, y: 0.30, size: geometry.size)
                light(Glow.tertiary, strength: Glow.tertiaryStrength, x: 0.50, y: 1, size: geometry.size)
            }
            .drawingGroup(colorMode: .linear)
            .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    private func light(_ color: Color, strength: Double, x: CGFloat, y: CGFloat, size: CGSize) -> some View {
        EllipticalGradient(stops: [
            .init(color: color.opacity(strength * (reduceTransparency ? 0.4 : 1)), location: 0),
            .init(color: Glass.transparent, location: 0.68)
        ], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
        .frame(width: size.width * 0.70 / 0.68, height: size.height * 0.70 / 0.68)
        .position(x: size.width * x, y: size.height * y)
    }
}

/// The system material blurs the content behind the surface, not its foreground text.
public struct AuroraSurface<S: InsettableShape>: View {
    let shape: S
    let glass: Glass
    let fill: Color?
    let stroke: Color?
    let shadow: Color?
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    @Environment(\.auroraReduceTransparency) private var previewReduceTransparency
    private var reduceTransparency: Bool { systemReduceTransparency || previewReduceTransparency }
    @Environment(\.colorSchemeContrast) private var contrast

    public init(shape: S, glass: Glass = .panel, fill: Color? = nil, stroke: Color? = nil, shadow: Color? = nil) {
        self.shape = shape; self.glass = glass; self.fill = fill; self.stroke = stroke; self.shadow = shadow
    }

    public var body: some View {
        ZStack {
            if reduceTransparency {
                shape.fill(Palette.panel2)
            } else {
                shape.fill(.ultraThinMaterial)
                    .environment(\.colorScheme, .dark)
                    .blendMode(.multiply)
                shape.fill(fill ?? glass.fill)
            }
            shape.strokeBorder(contrast == .increased ? Glass.contrastStroke : (stroke ?? glass.stroke), lineWidth: 1)
                .shadow(color: shadow ?? Glass.transparent, radius: 60)
        }
    }
}

extension View {
    public func auroraPanel(radius: CGFloat = Radius.card, stroke: Color? = nil, shadow: Color? = nil) -> some View {
        background(AuroraSurface(shape: RoundedRectangle(cornerRadius: radius, style: .continuous), stroke: stroke, shadow: shadow))
    }
}

public struct AuroraButtonStyle: ButtonStyle {
    public enum Tone { case primary, standard, destructive }
    let tone: Tone
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    @Environment(\.auroraReduceTransparency) private var previewReduceTransparency
    private var reduceTransparency: Bool { systemReduceTransparency || previewReduceTransparency }
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorSchemeContrast) private var contrast
    public init(_ tone: Tone = .standard) { self.tone = tone }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ui(16, .semibold))
            .padding(.horizontal, 16)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(tone == .primary ? Palette.onAccent : tone == .destructive ? Palette.down : Palette.text)
            .background { background }
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }

    @ViewBuilder private var background: some View {
        if tone == .primary {
            Capsule().fill(Palette.accent)
        } else if #available(iOS 26, *), !reduceTransparency {
            Capsule().fill(Glass.transparent).glassEffect(.regular, in: .capsule)
                .overlay {
                    if contrast == .increased { Capsule().strokeBorder(Glass.contrastStroke, lineWidth: 1) }
                }
        } else {
            AuroraSurface(shape: Capsule(), glass: .control)
        }
    }
}

public struct StatusHeadline: View {
    let eyebrow: String
    let headline: String
    let keyboardVisible: Bool
    @Environment(\.colorSchemeContrast) private var contrast
    public init(_ headline: String, eyebrow: String, keyboardVisible: Bool = false) {
        self.eyebrow = eyebrow; self.headline = headline; self.keyboardVisible = keyboardVisible
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(eyebrow.uppercased()).font(.mono(12, relativeTo: .caption)).tracking(2)
                .foregroundStyle(contrast == .increased ? Palette.text : Palette.text2)
            Text(headline).font(.ui(keyboardVisible ? 26 : 32, .semibold, relativeTo: .largeTitle)).tracking(-0.4)
                .foregroundStyle(Palette.text)
        }
        .accessibilityAddTraits(.isHeader)
    }
}
