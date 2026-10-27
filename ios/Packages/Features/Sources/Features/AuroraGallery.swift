#if DEBUG
import SwiftUI
import TrantorDesign

/// A debug-only component drill. Values below are explicitly gallery fixtures, never hub data.
struct AuroraGallery: View {
    @State private var message = ""
    @State private var response = "Gallery fixtures · no hub data"
    private let arguments = ProcessInfo.processInfo.arguments
    private var state: AuroraState {
        if arguments.contains("-gallery-red") { return .failed }
        if arguments.contains("-gallery-amber") { return .waiting }
        return .clear
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StatusHeadline(state.label, eyebrow: "Aurora component gallery")
                Text(response).font(.ui(13, relativeTo: .caption)).foregroundStyle(Palette.text2)
                HStack(alignment: .top) {
                    StatTile("Turns today", value: "24")
                    StatTile("Cards shipped", value: "8")
                    StatTile("Metered spend", value: "$2.40")
                }
                TrantorDesign.DecisionCard("Ship the reviewed change?", age: "2m", go: { response = "Go selected" }, noGo: { response = "No-go selected" })
                TrantorDesign.SeatCard("codex-11", cardID: "#12179", turnAge: "3m", activity: [1, 4, 2, 6, 3, 8, 5],
                         caption: "Building Aurora components", contextPercent: 42)
                TrantorDesign.ChatBubble("The components are ready for review.", speaker: .orchestrator, toolSummary: "trantor swap · 41s")
                HStack { Spacer(); TrantorDesign.ChatBubble("Show me the gallery.", speaker: .operator) }
                AskCard("Which surface should we inspect?", options: ["Cards", "Chat"]) { response = "Selected \($0)" }
                Composer(text: $message, attach: { response = "Attach selected" }, send: {
                    response = "Sent: \(message)"; message = ""
                })
                StatusHeadline("Compact variants", eyebrow: "Keyboard / narrow space", keyboardVisible: true)
                TrantorDesign.DecisionCard("Ship the change?", age: "2m", compact: true, go: { response = "Go selected" }, noGo: { response = "No-go selected" })
                TrantorDesign.SeatCard("codex-11", activity: [1, 4, 2, 6, 3, 8, 5], contextPercent: 42, compact: true)
                TrantorDesign.SeatCard("Idle seat", caption: "No activity series reported", idle: true)
            }
            .padding(20)
        }
        .background(AuroraBackground(state: state))
        .environment(\.auroraReduceTransparency, arguments.contains("-gallery-solid") || UIAccessibility.isReduceTransparencyEnabled)
    }
}
#endif
