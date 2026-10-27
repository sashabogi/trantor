import SwiftUI

public struct ChatBubble: View {
    public enum Speaker { case `operator`, orchestrator }
    let message: String
    let speaker: Speaker
    let toolSummary: String?
    @ScaledMetric private var lineSpacing = 8.8
    @Environment(\.colorSchemeContrast) private var contrast
    public init(_ message: String, speaker: Speaker, toolSummary: String? = nil) {
        self.message = message; self.speaker = speaker; self.toolSummary = toolSummary
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(.ui(16)).lineSpacing(lineSpacing)
            if let toolSummary {
                Text(toolSummary).font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(contrast == .increased ? Palette.text : Palette.text2)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(AuroraSurface(shape: Capsule(), glass: .control))
            }
        }
        .foregroundStyle(Palette.text)
        .padding(16)
        .background(AuroraSurface(
            shape: UnevenRoundedRectangle(topLeadingRadius: Radius.bubble,
                                          bottomLeadingRadius: speaker == .orchestrator ? Radius.tail : Radius.bubble,
                                          bottomTrailingRadius: speaker == .operator ? Radius.tail : Radius.bubble,
                                          topTrailingRadius: Radius.bubble),
            fill: speaker == .operator ? Glass.operatorFill : nil,
            stroke: speaker == .operator ? Glass.operatorStroke : nil))
    }
}

public struct AskCard: View {
    let question: String
    let options: [String]
    let choose: (String) -> Void
    public init(_ question: String, options: [String], choose: @escaping (String) -> Void) {
        self.question = question; self.options = options; self.choose = choose
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(question).font(.ui(17, .semibold, relativeTo: .headline)).foregroundStyle(Palette.text)
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button(option) { choose(option) }.buttonStyle(AuroraButtonStyle())
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .auroraPanel(stroke: Glass.waitingStroke)
        .shadow(color: Glass.waitingShadow, radius: 60)
    }
}

public struct Composer: View {
    @Binding var text: String
    let attach: () -> Void
    let send: () -> Void
    @FocusState private var focused: Bool
    public init(text: Binding<String>, attach: @escaping () -> Void, send: @escaping () -> Void) {
        self._text = text; self.attach = attach; self.send = send
    }
    public var body: some View {
        HStack(spacing: 4) {
            Button(action: attach) { Image(systemName: "plus") }
                .buttonStyle(AuroraButtonStyle()).accessibilityLabel("Attach")
            TextField("Message", text: $text, axis: .vertical)
                .font(.ui(16)).foregroundStyle(Palette.text).tint(Palette.accent)
                .lineLimit(1...5).focused($focused)
                .accessibilityLabel("Message")
            Button(action: send) { Image(systemName: "arrow.up") }
                .buttonStyle(AuroraButtonStyle(.primary))
                .shadow(color: Palette.accent.opacity(0.35), radius: 12)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
        }
        .padding(8)
        .background(AuroraSurface(shape: Capsule(), stroke: focused ? Glass.focusStroke : nil))
    }
}
