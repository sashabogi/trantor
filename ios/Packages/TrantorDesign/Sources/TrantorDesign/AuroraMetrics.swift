import SwiftUI

/// Activity already reported by the hub; empty and single-point series have no line.
public struct Sparkline: View {
    let values: [Double]
    let idle: Bool
    public init(_ values: [Double], idle: Bool = false) {
        self.values = values; self.idle = idle
    }
    public var body: some View {
        if values.count > 1 && values.allSatisfy({ $0.isFinite }) {
            GeometryReader { geo in
                let low = values.min() ?? 0
                let span = (values.max() ?? 0) - low
                Path { path in
                    for (index, value) in values.enumerated() {
                        let x = geo.size.width * CGFloat(index) / CGFloat(values.count - 1)
                        let fraction = span > 0 ? (value - low) / span : 0.5
                        let y = 1.2 + max(0, geo.size.height - 2.4) * (1 - fraction)
                        let point = CGPoint(x: x, y: y)
                        if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                }
                .stroke(idle ? Palette.textFaint : Palette.accent,
                        style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
            }
            .accessibilityLabel(idle ? "Idle activity history" : "Activity history")
        }
    }
}

public struct StatTile: View {
    let label: String
    let value: String
    let delta: String?
    let deltaUp: Bool
    @Environment(\.colorSchemeContrast) private var contrast
    public init(_ label: String, value: String, delta: String? = nil, deltaUp: Bool = true) {
        self.label = label; self.value = value; self.delta = delta; self.deltaUp = deltaUp
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value).font(.mono(26, .medium, relativeTo: .title)).monospacedDigit()
            Text(label).font(.ui(13, relativeTo: .caption))
                .foregroundStyle(contrast == .increased ? Palette.text : Palette.text2)
            if let delta {
                Text(delta).font(.mono(13, relativeTo: .caption))
                    .foregroundStyle(deltaUp ? Palette.up : Palette.down)
            }
        }
        .foregroundStyle(Palette.text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .auroraPanel(radius: Radius.tile)
        .accessibilityElement(children: .combine)
    }
}
