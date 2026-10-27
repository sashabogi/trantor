import SwiftUI

public struct DecisionCard: View {
    let sentence: String
    let age: String
    let compact: Bool
    let go: () -> Void
    let noGo: () -> Void
    public init(_ sentence: String, age: String, compact: Bool = false,
                go: @escaping () -> Void, noGo: @escaping () -> Void) {
        self.sentence = sentence; self.age = age; self.compact = compact
        self.go = go; self.noGo = noGo
    }
    public var body: some View {
        ViewThatFits(in: .horizontal) {
            if compact {
                HStack { details; actions }
            }
            VStack(alignment: .leading, spacing: 12) { details; actions }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .auroraPanel(stroke: Glass.waitingStroke)
        .shadow(color: Glass.waitingShadow, radius: 60)
    }
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            (Text("Waiting for you · ").font(.ui(13, relativeTo: .caption))
             + Text(age).font(.mono(13, relativeTo: .caption))).foregroundStyle(Palette.text)
            Text(sentence).font(.ui(17, .semibold, relativeTo: .headline)).foregroundStyle(Palette.text)
        }
    }
    private var actions: some View {
        HStack {
            Button("No-go", action: noGo).buttonStyle(AuroraButtonStyle(.destructive))
            Button("Go", action: go).buttonStyle(AuroraButtonStyle(.primary))
        }
    }
}

public struct SeatOrb: View {
    let name: String
    let size: CGFloat
    public init(_ name: String, size: CGFloat = 36) { self.name = name; self.size = size }
    public var body: some View {
        let hue = Palette.hue(for: name)
        Circle()
            .fill(RadialGradient(colors: [Glass.orbHighlight, hue], center: .topLeading, startRadius: 0, endRadius: size))
            .frame(width: size, height: size)
            .shadow(color: hue.opacity(0.55), radius: 12)
            .accessibilityHidden(true)
    }
}

public struct SeatCard: View {
    let name: String
    let cardID: String?
    let turnAge: String?
    let activity: [Double]
    let caption: String?
    let contextPercent: Int?
    let compact: Bool
    let idle: Bool
    @Environment(\.colorSchemeContrast) private var contrast
    public init(_ name: String, cardID: String? = nil, turnAge: String? = nil,
                activity: [Double] = [], caption: String? = nil, contextPercent: Int? = nil,
                compact: Bool = false, idle: Bool = false) {
        self.name = name; self.cardID = cardID; self.turnAge = turnAge; self.activity = activity
        self.caption = caption; self.contextPercent = contextPercent; self.compact = compact; self.idle = idle
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                SeatOrb(name, size: compact ? 28 : 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.ui(17, .semibold, relativeTo: .headline))
                    if !compact {
                        Text([cardID, turnAge].compactMap { $0 }.joined(separator: " · "))
                            .font(.mono(13, relativeTo: .caption)).foregroundStyle(secondary)
                    }
                }
                Spacer(minLength: 0)
                if compact && activity.count > 1 { Sparkline(activity, idle: idle).frame(width: 64, height: 24) }
                if let contextPercent {
                    Text("\(contextPercent)%").font(.mono(13, relativeTo: .caption))
                        .accessibilityLabel("Context \(contextPercent) percent")
                }
            }
            if !compact {
                if activity.count > 1 { Sparkline(activity, idle: idle).frame(maxWidth: 200).frame(height: 28) }
                if let caption { Text(caption).font(.ui(13, relativeTo: .caption)).foregroundStyle(secondary) }
            }
        }
        .foregroundStyle(Palette.text)
        .padding(16)
        .auroraPanel(radius: compact ? Radius.tile : Radius.card)
    }
    private var secondary: Color { contrast == .increased ? Palette.text : Palette.text2 }
}
