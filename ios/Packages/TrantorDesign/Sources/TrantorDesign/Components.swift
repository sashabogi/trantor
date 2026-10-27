import SwiftUI

// MARK: - Stage

/// The lit stage behind every screen: navy gradient plus two soft radial glows (mint high right,
/// session-blue low left). Static on purpose, as in ibkr.
public struct StageBackground: View {
    public init() {}
    public var body: some View {
        GeometryReader { geo in
            ZStack {
                LinearGradient(colors: [Palette.stage, Palette.ground], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [Palette.accent.opacity(0.07), .clear],
                               center: UnitPoint(x: 0.62, y: 0.30), startRadius: 0,
                               endRadius: max(geo.size.width, geo.size.height) * 0.7)
                RadialGradient(colors: [Palette.window.opacity(0.06), .clear],
                               center: UnitPoint(x: 0.08, y: 1.0), startRadius: 0,
                               endRadius: max(geo.size.width, geo.size.height) * 0.6)
            }
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// Puts the stage behind a screen and hides the system list background.
    public func stage() -> some View {
        self.scrollContentBackground(.hidden)
            .background(StageBackground())
    }
}

// MARK: - Card

/// The floating column card: translucent panel fill so the stage light reads through, a 1px
/// line-2 ring, a faint top rim light and a soft drop.
public struct CardStyle: ViewModifier {
    var padding: CGFloat
    var highlighted: Bool
    public func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                    .fill(LinearGradient(colors: [Palette.panel.opacity(0.84), Palette.panel.opacity(0.60)],
                                         startPoint: .top, endPoint: .bottom))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                    .strokeBorder(highlighted ? Palette.accent.opacity(0.35) : Palette.line2, lineWidth: 1)
            )
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                    .stroke(Color.white.opacity(0.025), lineWidth: 1)
                    .mask(LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .center))
            }
            .shadow(color: .black.opacity(0.6), radius: 20, x: 0, y: 14)
    }
}

extension View {
    public func card(padding: CGFloat = Space.md + 2, highlighted: Bool = false) -> some View {
        modifier(CardStyle(padding: padding, highlighted: highlighted))
    }

    /// An inset well (inputs, code, ladders).
    public func well(padding: CGFloat = Space.sm + 2) -> some View {
        self.padding(padding)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Palette.ink))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline))
    }
}

/// A titled panel: eyebrow label, optional trailing accessory, content.
public struct Panel<Content: View, Accessory: View>: View {
    let title: String
    let accessory: Accessory
    let content: Content
    public init(_ title: String, @ViewBuilder accessory: () -> Accessory = { EmptyView() }, @ViewBuilder content: () -> Content) {
        self.title = title; self.accessory = accessory(); self.content = content()
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: Space.sm + 2) {
            HStack { Eyebrow(title); Spacer(); accessory }
            content
        }
        .card()
    }
}

// MARK: - Buttons

public enum ActionTone { case primary, danger, ghost, quiet }

/// ibkr action button: solid mint for the primary action, solid down-red for destructive,
/// hairline ghost for the rest.
public struct ActionButtonStyle: ButtonStyle {
    var tone: ActionTone
    var compact: Bool
    @Environment(\.isEnabled) private var isEnabled

    public init(_ tone: ActionTone = .primary, compact: Bool = false) { self.tone = tone; self.compact = compact }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ui(compact ? 13 : 14.5, .semibold, relativeTo: .callout))
            .lineLimit(1)
            .padding(.horizontal, compact ? 12 : 16)
            .padding(.vertical, compact ? 7 : 10)
            .frame(minHeight: 36)
            .foregroundStyle(foreground)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(fill(configuration.isPressed)))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(stroke))
            .shadow(color: tone == .primary && isEnabled ? Palette.accent.opacity(0.35) : .clear, radius: 12)
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(Motion.ease, value: configuration.isPressed)
    }

    private var foreground: Color {
        switch tone {
        case .primary: return Palette.onAccent
        case .danger: return Palette.onDown
        case .ghost: return Palette.text
        case .quiet: return Palette.text2
        }
    }
    private func fill(_ pressed: Bool) -> Color {
        switch tone {
        case .primary: return pressed ? Palette.accent.opacity(0.85) : Palette.accent
        case .danger: return pressed ? Palette.down.opacity(0.85) : Palette.down
        case .ghost: return pressed ? Palette.raise : Color.white.opacity(0.05)
        case .quiet: return pressed ? Palette.raise : .clear
        }
    }
    private var stroke: Color {
        switch tone {
        case .primary, .danger: return .clear
        case .ghost: return Palette.line2
        case .quiet: return Palette.hairline
        }
    }
}

extension ButtonStyle where Self == ActionButtonStyle {
    public static var primary: ActionButtonStyle { ActionButtonStyle(.primary) }
    public static var danger: ActionButtonStyle { ActionButtonStyle(.danger) }
    public static var ghost: ActionButtonStyle { ActionButtonStyle(.ghost) }
    public static func action(_ tone: ActionTone, compact: Bool = false) -> ActionButtonStyle { ActionButtonStyle(tone, compact: compact) }
}

// MARK: - Chips, dots, tags

/// A small mono tag ("1m", "ETH", a project name, a status).
public struct Chip: View {
    let text: String
    var color: Color
    var filled: Bool
    public init(_ text: String, color: Color = Palette.text2, filled: Bool = false) {
        self.text = text; self.color = color; self.filled = filled
    }
    public var body: some View {
        Text(text)
            .font(.mono(11, .medium, relativeTo: .caption2))
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(filled ? Palette.onAccent : color)
            .background(RoundedRectangle(cornerRadius: Radius.xs, style: .continuous)
                .fill(filled ? color : color.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: Radius.xs, style: .continuous)
                .strokeBorder(filled ? .clear : color.opacity(0.22)))
    }
}

/// The live dot: pulses while `live`, steady and dim otherwise.
public struct StatusDot: View {
    var color: Color
    var live: Bool
    @State private var pulse = false
    public init(_ color: Color = Palette.live, live: Bool = true) { self.color = color; self.live = live }
    public var body: some View {
        ZStack {
            if live {
                Circle().fill(color.opacity(0.35))
                    .scaleEffect(pulse ? 2.2 : 1).opacity(pulse ? 0 : 0.8)
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false), value: pulse)
            }
            Circle().fill(live ? color : Palette.textFaint)
                .shadow(color: live ? color.opacity(0.6) : .clear, radius: 4)
        }
        .frame(width: 7, height: 7)
        .onAppear { if live { pulse = true } }
        .accessibilityHidden(true)
    }
}

/// A count badge: mint when it needs attention, dim otherwise.
public struct CountBadge: View {
    let count: Int
    var hot: Bool
    public init(_ count: Int, hot: Bool = true) { self.count = count; self.hot = hot }
    public var body: some View {
        Text("\(count)")
            .font(.mono(11, .semibold, relativeTo: .caption2)).monospacedDigit()
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .foregroundStyle(hot ? Palette.onAccent : Palette.text2)
            .background(Capsule().fill(hot ? Palette.accent : Palette.raise))
    }
}

/// A seat or project avatar: initials on its stable hue.
public struct NameMark: View {
    let name: String
    var size: CGFloat
    public init(_ name: String, size: CGFloat = 28) { self.name = name; self.size = size }
    public var body: some View {
        let hue = Palette.hue(for: name)
        Text(initials)
            .font(.mono(size * 0.38, .semibold))
            .foregroundStyle(hue)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).fill(hue.opacity(0.12)))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(hue.opacity(0.28)))
            .accessibilityHidden(true)
    }
    private var initials: String {
        let base = name.split(separator: ":").first.map(String.init) ?? name
        let parts = base.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " || $0 == "@" })
        if parts.count >= 2 { return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased() }
        return String(base.prefix(2)).uppercased()
    }
}

/// A thin divider in hairline.
public struct Hairline: View {
    public init() {}
    public var body: some View { Rectangle().fill(Palette.hairline).frame(height: 1) }
}

/// A segmented pill row ("Since open | Vs settle").
public struct PillPicker<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T
    public init(_ options: [(T, String)], selection: Binding<T>) { self.options = options; self._selection = selection }
    public var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { opt in
                Button { withAnimation(Motion.ease) { selection = opt.0 } } label: {
                    Text(opt.1)
                        .font(.ui(12.5, .medium, relativeTo: .caption))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .foregroundStyle(selection == opt.0 ? Palette.text : Palette.textDim)
                        .background(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
                            .fill(selection == opt.0 ? Palette.raise : .clear))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == opt.0 ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Palette.ink))
        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline))
    }
}

/// A text field in an inset well.
public struct WellField: View {
    let placeholder: String
    @Binding var text: String
    var mono: Bool
    var axis: Axis
    public init(_ placeholder: String, text: Binding<String>, mono: Bool = false, axis: Axis = .horizontal) {
        self.placeholder = placeholder; self._text = text; self.mono = mono; self.axis = axis
    }
    public var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Palette.textFaint), axis: axis)
            .font(mono ? .tData : .tBody)
            .foregroundStyle(Palette.text)
            .tint(Palette.accent)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.line2))
    }
}

/// The empty state: icon in a soft mint ring, a title and a line of explanation.
public struct StageEmpty: View {
    let title: String
    let systemImage: String
    var message: String
    public init(_ title: String, systemImage: String, message: String = "") {
        self.title = title; self.systemImage = systemImage; self.message = message
    }
    public var body: some View {
        VStack(spacing: Space.md) {
            Image(systemName: systemImage)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Palette.accent)
                .frame(width: 64, height: 64)
                .background(Circle().fill(Palette.accentSoft))
                .overlay(Circle().strokeBorder(Palette.accent.opacity(0.25)))
                .shadow(color: Palette.accent.opacity(0.25), radius: 18)
            Text(title).font(.tHeadline).foregroundStyle(Palette.text)
            if !message.isEmpty {
                Text(message).font(.tCallout).foregroundStyle(Palette.textDim).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl * 2)
        .padding(.horizontal, Space.xl)
    }
}
